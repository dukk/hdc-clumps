#!/usr/bin/env node
/**
 * Maintain SolidTime (upgrade to configured or latest release).
 *
 * Usage: hdc run service solidtime maintain -- [--instance a] [--skip-upgrade] [--check-latest] [--version v0.12.2] [--skip-clamav]
 */
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { resolveSolidtimeDeployments } from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "hdc/package/solidtime-install.mjs";
import {
  maintainSolidtimeInCt,
  applySolidtimeMailInCt,
  applySolidtimeProxyEnvInCt,
  ensureSolidtimeKeysInCt,
  ensureSolidtimeProductionEnvInCt,
  ensureSolidtimeSystemdInCt,
} from "hdc/package/solidtime-maintain.mjs";
import { solidtimeReportExtraSections } from "hdc/package/solidtime-report.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/solidtime/config.example.json";
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
 * @param {ReturnType<typeof resolveSolidtimeDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function maintainOne(deployment, flags, vaultAccess) {
  const { systemId, proxmox: px, solidtime } = deployment;
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
  const solidtimeCfg = isObject(solidtime) ? solidtime : {};
  const skipUpgrade = flags["skip-upgrade"] !== undefined;
  const checkLatest = flags["check-latest"] !== undefined;
  const versionOverride = flagGet(flags, "version");

  const result = await maintainSolidtimeInCt(pveSsh.user, pveSsh.host, vmid, solidtimeCfg, {
    skipUpgrade,
    checkLatest,
    versionOverride: versionOverride || undefined,
  });
  const proxy_env = applySolidtimeProxyEnvInCt(pveSsh.user, pveSsh.host, vmid, solidtimeCfg);
  if (proxy_env.ok) {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} ${proxy_env.message}\n`);
  } else {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} proxy env failed: ${proxy_env.message}\n`);
  }
  const keys = ensureSolidtimeKeysInCt(pveSsh.user, pveSsh.host, vmid);
  if (keys.ok) {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} ${keys.message}\n`);
  } else {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} keys failed: ${keys.message}\n`);
  }
  const production_env = ensureSolidtimeProductionEnvInCt(pveSsh.user, pveSsh.host, vmid);
  if (production_env.ok) {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} ${production_env.message}\n`);
  } else {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} production env failed: ${production_env.message}\n`);
  }
  const systemd = ensureSolidtimeSystemdInCt(pveSsh.user, pveSsh.host, vmid);
  if (systemd.ok) {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} ${systemd.message}\n`);
  } else {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} systemd failed: ${systemd.message}\n`);
  }
  const mail = applySolidtimeMailInCt(pveSsh.user, pveSsh.host, vmid, solidtimeCfg);
  const log = provisionLogFromConsole(console);
  const exec = createConfigureExec("pct", {
    user: pveSsh.user,
    host: pveSsh.host,
    vmid,
    pveHost: pveSsh.host,
  });
  const baseline = await ensureGuestLinuxBaseline({ exec, log, flags, vaultAccess, deployment, proxmoxPackageRoot: proxmoxRoot });
  return {
    system_id: systemId,
    host_id: hostId,
    vmid,
    ...result,
    proxy_env,
    keys,
    production_env,
    systemd,
    mail,
    ok:
      result.ok &&
      baseline.ok &&
      proxy_env.ok !== false &&
      keys.ok !== false &&
      production_env.ok !== false &&
      systemd.ok !== false &&
      mail.ok !== false,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: SolidTime upgrade (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    errout.write(`[hdc] ${target} ${verb}: missing clumps/services/solidtime/config.json\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing" }, null, 2)}\n`,
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
    deployments = resolveSolidtimeDeployments(cfg, flags, { skipInstall: true });
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, unknown>[]} */
  const instances = [];
  for (const deployment of deployments) {
    try {
      instances.push(await maintainOne(deployment, flags, vaultAccess));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      instances.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = instances.every((r) => r.ok);
  const payload = { ok, target, verb, count: instances.length, instances };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    extraSections: solidtimeReportExtraSections,
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
