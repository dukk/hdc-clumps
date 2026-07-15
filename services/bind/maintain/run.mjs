#!/usr/bin/env node
/**
 * Re-sync BIND zone files on primary, named options on all nodes, verify SOA on secondary.
 *
 * Usage: hdc run service bind maintain -- [--skip-admin-user] [--skip-clamav] [--skip-guest-agent] [--skip-apt] [--skip-disk-resize] [--skip-log-purge]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  bindGlobalSettings,
  normalizeBindConfig,
  resolveBindDeployments,
} from "hdc/package/deployments.mjs";
import { createConfigureExec, syncNamedOptions, syncPrimaryZoneFiles } from "hdc/package/bind-configure.mjs";
import { syncDnscryptProxyOdoh } from "hdc/package/bind-dnscrypt-configure.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { waitForSoaSerialMatch } from "hdc/package/bind-query-remote.mjs";
import { bindReportExtraSections } from "hdc/package/bind-report.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { mergeGuestBaselineIntoResult, guestBaselineUsersOk, guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { soaSerialFromTimestamp } from "hdc/package/bind-zones.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { ensureQemuGuestAgentForDeploymentMaintain } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-for-deployment.mjs";
import { syncQemuRootfsOnMaintain } from "hdc/package/qemu-rootfs-resize.mjs";
import { ensureBindLogPurgeSchedule } from "hdc/package/bind-log-purge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/bind/config.example.json";
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

/**
 * @param {ReturnType<typeof resolveBindDeployments>[number]} deployment
 * @param {string} defaultHost
 */
function sshTarget(deployment, defaultHost) {
  const ssh = isObject(deployment.configure) && isObject(deployment.configure.ssh)
    ? deployment.configure.ssh
    : {};
  const user = resolveGuestSshUser(ssh.user);
  const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : defaultHost;
  return { user, host };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: BIND zone sync and SOA check (stderr log; JSON on stdout).\n`);

  const cfg = ensurePackageConfig().data;
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const normalized = normalizeBindConfig(cfg);
  const global = bindGlobalSettings(normalized);
  const deployments = resolveBindDeployments(cfg, flags);
  const primary = deployments.find((d) => d.role === "primary");
  const secondary = deployments.find((d) => d.role === "secondary");

  const log = provisionLogFromConsole(console);
  const serial = soaSerialFromTimestamp();
  errout.write(`[hdc] ${target} ${verb}: SOA serial ${serial} (UTC timestamp)\n`);

  const skipGuestAgent = flagGet(flags, "skip-guest-agent") !== undefined;
  const skipApt = flagGet(flags, "skip-apt") !== undefined;

  /** @type {Record<string, unknown>[]} */
  const results = [];

  if (!skipGuestAgent) {
    for (const deployment of deployments) {
      if (deployment.mode !== "proxmox-qemu") continue;
      const defaultHost =
        deployment.role === "primary" ? global.primaryIp : global.secondaryIp;
      errout.write(`[hdc] ${target} ${verb}: qemu-guest-agent on ${deployment.systemId} …\n`);
      const guestAgent = await ensureQemuGuestAgentForDeploymentMaintain({
        proxmoxPackageRoot: proxmoxRoot,
        deployment,
        defaultSshHost: defaultHost,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        existing.guest_agent = guestAgent;
        if (!guestAgent.ok) existing.ok = false;
      } else {
        results.push({
          ok: guestAgent.ok !== false,
          system_id: deployment.systemId,
          role: deployment.role,
          guest_agent: guestAgent,
        });
      }
    }
  }

  for (const deployment of deployments) {
    if (deployment.mode === "proxmox-qemu") {
      errout.write(`[hdc] ${target} ${verb}: disk resize check on ${deployment.systemId} …\n`);
      try {
        const diskResize = await syncQemuRootfsOnMaintain({
          proxmoxPackageRoot: proxmoxRoot,
          deployment,
          flags,
          log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
        });
        const existing = results.find((r) => r.system_id === deployment.systemId);
        if (existing) {
          existing.disk_resize = diskResize;
          if (diskResize.ok === false) existing.ok = false;
        } else {
          results.push({
            ok: diskResize.ok !== false,
            system_id: deployment.systemId,
            role: deployment.role,
            disk_resize: diskResize,
          });
        }
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} disk resize failed: ${msg}\n`);
        results.push({
          ok: false,
          system_id: deployment.systemId,
          role: deployment.role,
          message: msg,
        });
      }
    }
  }

  for (const deployment of deployments) {
    const defaultHost = deployment.role === "primary" ? global.primaryIp : global.secondaryIp;
    const { user, host } = sshTarget(deployment, defaultHost);
    errout.write(`[hdc] ${target} ${verb}: syncing upstream and named options on ${user}@${host} …\n`);
    try {
      const exec = createConfigureExec("ssh", { user, host });
      let dnscrypt = null;
      if (global.forwardUpstream.mode === "odoh") {
        dnscrypt = syncDnscryptProxyOdoh({
          exec,
          log,
          forwardUpstream: global.forwardUpstream,
          skipApt,
        });
      }
      const options = syncNamedOptions({
        exec,
        log,
        allowQueryCidrs: global.allowQueryCidrs,
        recursion: global.recursion,
        dnssecValidation: global.dnssecValidation,
        forwarders: global.forwarders,
      });
      results.push({
        ok: true,
        system_id: deployment.systemId,
        role: deployment.role,
        ...(dnscrypt ? { dnscrypt_proxy: dnscrypt } : {}),
        options,
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} options sync failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, role: deployment.role, message: msg });
    }
  }

  if (primary) {
    const { user, host } = sshTarget(primary, global.primaryIp);
    errout.write(`[hdc] ${target} ${verb}: syncing zones on primary ${user}@${host} …\n`);
    try {
      const exec = createConfigureExec("ssh", { user, host });
      const zoneSync = syncPrimaryZoneFiles({
        exec,
        log,
        zoneIds: global.zoneIds,
        zoneDefinitions: global.zoneDefinitions,
        primaryIp: global.primaryIp,
        secondaryIp: global.secondaryIp,
        hostmaster: global.hostmaster,
        serial,
        repoRoot: root,
      });
      const row = results.find((r) => r.system_id === primary.systemId);
      if (row) {
        row.zone_sync = zoneSync.details;
      } else {
        results.push({
          ok: true,
          system_id: primary.systemId,
          role: "primary",
          zone_sync: zoneSync.details,
        });
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: primary zone sync failed: ${msg}\n`);
      results.push({ ok: false, system_id: primary.systemId, role: "primary", message: msg });
    }
  }

  if (primary && secondary && global.zoneIds.length) {
    const zone = global.zoneIds[0];
    const { user: pUser, host: pHost } = sshTarget(primary, global.primaryIp);
    const { user: sUser, host: sHost } = sshTarget(secondary, global.secondaryIp);
    const primaryExec = createConfigureExec("ssh", { user: pUser, host: pHost });
    const secondaryExec = createConfigureExec("ssh", { user: sUser, host: sHost });
    errout.write(`[hdc] ${target} ${verb}: verifying SOA serial for ${zone} …\n`);
    const soaCheck = await waitForSoaSerialMatch({
      zone,
      primaryExec,
      secondaryExec,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
    results.push({
      ...soaCheck,
      system_id: secondary.systemId,
      role: "secondary",
    });
  }

  for (const deployment of deployments) {
    const defaultHost = deployment.role === "primary" ? global.primaryIp : global.secondaryIp;
    const { user, host } = sshTarget(deployment, defaultHost);
    errout.write(`[hdc] ${target} ${verb}: log purge cron on ${deployment.systemId} (${user}@${host}) …\n`);
    try {
      const exec = createConfigureExec("ssh", { user, host });
      const logPurge = ensureBindLogPurgeSchedule({
        exec,
        log,
        systemId: deployment.systemId,
        bindBlock: normalized.bind,
        flags,
      });
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        existing.log_purge = logPurge;
        if (logPurge.ok === false) existing.ok = false;
      } else {
        results.push({
          ok: logPurge.ok !== false,
          system_id: deployment.systemId,
          role: deployment.role,
          log_purge: logPurge,
        });
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: log purge on ${deployment.systemId}: ${msg}\n`);
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        existing.ok = false;
        existing.log_purge = { ok: false, message: msg };
      } else {
        results.push({
          ok: false,
          system_id: deployment.systemId,
          role: deployment.role,
          log_purge: { ok: false, message: msg },
        });
      }
    }
  }

  for (const deployment of deployments) {
    const defaultHost = deployment.role === "primary" ? global.primaryIp : global.secondaryIp;
    const { user, host } = sshTarget(deployment, defaultHost);
    errout.write(`[hdc] ${target} ${verb}: guest baseline on ${deployment.systemId} (${user}@${host}) …\n`);
    try {
      const exec = createConfigureExec("ssh", { user, host });
      const baseline = await ensureGuestLinuxBaseline({
        exec,
        log,
        flags,
        vaultAccess,
        deployment,
        proxmoxPackageRoot: proxmoxRoot,
        repoRoot: root,
      });
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        mergeGuestBaselineIntoResult(existing, baseline);
      } else {
        results.push({
          ok: guestBaselineUsersOk(baseline),
          system_id: deployment.systemId,
          role: deployment.role,
          ...guestBaselineResultFields(baseline),
        });
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: baseline on ${deployment.systemId}: ${msg}\n`);
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        existing.ok = false;
        existing.baseline_error = msg;
      } else {
        results.push({
          ok: false,
          system_id: deployment.systemId,
          role: deployment.role,
          message: msg,
        });
      }
    }
  }

  const ok = results.every((r) => r.ok !== false);
  const payload = { ok, target, verb, count: results.length, results };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    extraSections: bindReportExtraSections,
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
