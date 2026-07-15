#!/usr/bin/env node
/**
 * Maintain CrowdSec and optionally sync firewall bouncers.
 *
 * Usage: hdc run service crowdsec maintain -- [--instance a | --system-id crowdsec-a]
 *        hdc run service crowdsec maintain -- [--skip-upgrade] [--skip-collections] [--sync-bouncers] [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { resolveCrowdsecDeployments, crowdsecLapiPort } from "hdc/package/deployments.mjs";
import { resolvePveSshForHost, maintainCrowdsecInCt, readCtPrimaryIp } from "hdc/package/crowdsec-install.mjs";
import { resolveEnrollToken } from "hdc/package/vault-secrets.mjs";
import { syncCrowdsecBouncers } from "hdc/package/crowdsec-bouncer-sync.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { ensureWazuhLogCollection } from "hdc/package/wazuh-log-collection.mjs";
import { resolveCrowdsecWazuhLogCollection } from "hdc/package/wazuh-log-collection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/crowdsec/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let pkgConfig = null;
function ensurePackageConfig() {
  if (!pkgConfig) {
    pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return pkgConfig;
}

const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolveCrowdsecDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof createPackageVaultAccess>} vaultAccess
 */
async function maintainOne(deployment, flags, vaultAccess) {
  const { systemId, proxmox: px, crowdsec } = deployment;
  if (!isObject(px)) return { ok: false, system_id: systemId, message: "bad proxmox config" };
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!hostId || !Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, message: "missing host_id or vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${hostId} vmid ${vmid} ...\n`);
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const crowdsecCfg = isObject(crowdsec) ? crowdsec : {};
  const enroll = await resolveEnrollToken(vaultAccess, crowdsecCfg);
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  const skipCollections = flagGet(flags, "skip-collections", "skip_collections") !== undefined;
  const result = await maintainCrowdsecInCt(pveSsh.user, pveSsh.host, vmid, crowdsecCfg, {
    enrollToken: enroll.token,
    skipUpgrade,
    skipCollections,
    skipHubUpdate: skipUpgrade,
  });
  const log = provisionLogFromConsole(console);
  const exec = createConfigureExec("pct", {
    user: pveSsh.user,
    host: pveSsh.host,
    vmid,
    pveHost: pveSsh.host,
  });
  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags,
    vaultAccess,
    deployment,
    proxmoxPackageRoot: proxmoxRoot,
  });
  const wazuhLogEntries = resolveCrowdsecWazuhLogCollection(readCfg());
  const wazuh_log_collection = await ensureWazuhLogCollection({
    exec,
    log,
    flags,
    entries: wazuhLogEntries,
  });

  /** @type {Record<string, unknown> | null} */
  let bouncerSync = null;
  const syncBouncers = flagGet(flags, "sync-bouncers", "sync_bouncers") !== undefined;
  const ctIp = readCtPrimaryIp(pveSsh.user, pveSsh.host, vmid);
  if (syncBouncers) {
    errout.write(`[hdc] ${target} ${verb}: ${systemId}: syncing firewall bouncers ...\n`);
    bouncerSync = await syncCrowdsecBouncers({
      repoRoot: root,
      lapiUser: pveSsh.user,
      lapiHost: pveSsh.host,
      lapiVmid: vmid,
      lapiIp: ctIp,
      crowdsec: crowdsecCfg,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    });
  }

  return {
    ok:
      result.ok &&
      baseline.ok &&
      (wazuh_log_collection.ok !== false || wazuh_log_collection.skipped === true) &&
      (!bouncerSync || bouncerSync.ok === true),
    system_id: systemId,
    host_id: hostId,
    vmid,
    lapi_url: ctIp ? `http://${ctIp}:${crowdsecLapiPort(crowdsecCfg)}` : null,
    ...result,
    ...guestBaselineResultFields(baseline),
    wazuh_log_collection,
    bouncer_sync: bouncerSync,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: re-apply CrowdSec config (stderr log; JSON on stdout).\n`);
  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing - see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  let deployments;
  try {
    deployments = resolveCrowdsecDeployments(cfg, flags);
  } catch (e) {
    const message = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainOne(deployment, flags, vaultAccess));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok);
  const payload = { ok, target, verb, count: results.length, results };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
