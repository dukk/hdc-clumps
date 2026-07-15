#!/usr/bin/env node
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Maintain Uptime Kuma (upgrade or restart) and reconcile monitors.
 *
 * Usage: hdc run service uptime-kuma maintain -- [--instance a | --system-id uptime-kuma-a]
 *        [--skip-upgrade] [--skip-clamav] [--skip-monitors] [--skip-status-pages] [--prune] [--dry-run] [--monitor <id>]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { resolveUptimeKumaDeployments } from "hdc/package/deployments.mjs";
import { maintainUptimeKumaInCt, maintainUptimeKumaOverSsh } from "hdc/package/uptime-kuma-maintain.mjs";
import {
  maintainCaddyForOciVm,
  resolveOciAdminIngress,
  resolvePveSshForHost,
  resolvePublicUrlHostname,
  resolveSshTargetFromConfigure,
} from "hdc/package/uptime-kuma-install.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { runUptimeKumaSync } from "hdc/package/uptime-kuma-monitor-sync-runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/uptime-kuma/config.example.json";
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
 * @param {ReturnType<typeof resolveUptimeKumaDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function maintainOne(deployment, flags, vaultAccess) {
  const { systemId, mode, proxmox: px, uptimeKuma, configure, oci } = deployment;
  const skipUpgrade = flags["skip-upgrade"] !== undefined;
  const ukCfg = isObject(uptimeKuma) ? uptimeKuma : {};

  if (mode === "oci-vm") {
    const ssh = resolveSshTargetFromConfigure(configure);
    if (!ssh) {
      return { ok: false, system_id: systemId, message: "configure.ssh.host required for oci-vm maintain" };
    }
    errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${ssh.user}@${ssh.host} (oci-vm) …\n`);
    const result = await maintainUptimeKumaOverSsh(ssh.host, ssh.user, ukCfg, { skipUpgrade });
    const publicHostname = resolvePublicUrlHostname(ukCfg);
    /** @type {Record<string, unknown> | null} */
    let caddyResult = null;
    if (publicHostname) {
      const adminIngress = resolveOciAdminIngress(oci);
      caddyResult = await maintainCaddyForOciVm(ssh.host, ssh.user, publicHostname, adminIngress);
    }
    const ok = result.ok && (!caddyResult || caddyResult.ok);
    return {
      system_id: systemId,
      mode,
      host: ssh.host,
      ...result,
      caddy: caddyResult,
      ok,
    };
  }

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
  const result = await maintainUptimeKumaInCt(pveSsh.user, pveSsh.host, vmid, ukCfg, { skipUpgrade });
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
    ok: result.ok && baseline.ok,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Uptime Kuma upgrade/restart + monitor sync (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    errout.write(`[hdc] ${target} ${verb}: missing clumps/services/uptime-kuma/config.json\n`);
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
    deployments = resolveUptimeKumaDeployments(cfg, flags, { skipInstall: true });
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

  /** @type {Record<string, unknown> | null} */
  let syncResult = null;
  try {
    syncResult = await runUptimeKumaSync({
      clumpRoot,
      cfgRaw: cfg,
      flags,
      vaultAccess,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: sync failed: ${msg}\n`);
    syncResult = {
      ok: false,
      error: msg,
      monitor_sync: { ok: false, error: msg, results: [] },
      status_page_sync: { ok: false, error: msg, results: [] },
    };
  }

  const guestOk = instances.every((r) => r.ok);
  const syncOk = syncResult?.ok !== false;
  const ok = guestOk && syncOk;
  const payload = {
    ok,
    target,
    verb,
    count: instances.length,
    instances,
    monitor_sync: syncResult?.monitor_sync ?? null,
    status_page_sync: syncResult?.status_page_sync ?? null,
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
