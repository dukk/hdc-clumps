#!/usr/bin/env node
/**
 * Maintain Nagios: regenerate checks from BIND and reload LXC guests.
 *
 * Usage: hdc run service nagios maintain -- [--instance a | --system-id nagios-a]
 *        hdc run service nagios maintain -- [--apply-upgrades] [--skip-upgrade] [--skip-admin-user]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import { normalizeNagiosConfig, resolveNagiosDeployments } from "hdc/package/deployments.mjs";
import { loadNagiosBindBundle } from "hdc/package/bind-monitored-hosts.mjs";
import { resolvePveSshForHost } from "hdc/package/nagios-install.mjs";
import { maintainNagiosInCt } from "hdc/package/nagios-configure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/nagios/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
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
 * @param {ReturnType<typeof resolveNagiosDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {string} nagiosCfg
 * @param {ReturnType<typeof createPackageVaultAccess>} vaultAccess
 */
async function maintainOne(deployment, flags, nagiosCfg, vaultAccess) {
  const { systemId, proxmox: px } = deployment;
  const applyUpgrades = flagGet(flags, "apply-upgrades", "apply_upgrades") !== undefined;
  const skipUpgrade =
    !applyUpgrades || flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!hostId || !Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, message: "missing host_id or vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${hostId} vmid ${vmid} …\n`);
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const result = await maintainNagiosInCt(pveSsh.user, pveSsh.host, vmid, nagiosCfg, { skipUpgrade });

  errout.write(`[hdc] ${target} ${verb}: guest baseline on ${systemId} (vmid ${vmid}) …\n`);
  const log = provisionLogFromConsole(console);
  const exec = createConfigureExec("pct", {
    user: pveSsh.user,
    host: pveSsh.host,
    vmid,
    pveHost: pveSsh.host,
  });
  const baselineFlags = { ...flags, "skip-clamav": "1" };
  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags: baselineFlags,
    vaultAccess,
    deployment,
    proxmoxPackageRoot: proxmoxRoot,
  });

  return {
    ...result,
    system_id: systemId,
    host_id: hostId,
    vmid,
    skip_upgrade: skipUpgrade,
    ...guestBaselineResultFields(baseline),
    ok: result.ok !== false && baseline.admin_user?.ok !== false,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: regenerate Nagios from BIND (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  let norm;
  let deployments;
  try {
    norm = normalizeNagiosConfig(cfg);
    deployments = resolveNagiosDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  let bindBundle;
  try {
    bindBundle = loadNagiosBindBundle(root, norm.bindConfigPath, {
      adminEmail: norm.notifications?.adminEmail,
    });
    errout.write(
      `[hdc] ${target} ${verb}: BIND ${bindBundle.bindPath} → ${bindBundle.stats.hostCount} hosts.\n`,
    );
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainOne(deployment, flags, bindBundle.nagiosCfg, vaultAccess));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok);
  const payload = {
    ok,
    target,
    verb,
    count: results.length,
    bind_config_path: bindBundle.bindPath,
    bind_host_count: bindBundle.stats.hostCount,
    results,
  };
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
