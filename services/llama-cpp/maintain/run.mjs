#!/usr/bin/env node
/**
 * Maintain llama-cpp: upgrade binary from GitHub release and restart llama-server.
 *
 * Usage: hdc run service llama-cpp maintain -- [--instance a | --system-id llama-cpp-a]
 *        hdc run service llama-cpp maintain -- [--skip-restart] [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { resolveLlamaCppDeployments } from "hdc/package/deployments.mjs";
import {
  installLlamaCppInCt,
  installLlamaCppViaSsh,
  resolvePveSshForHost,
} from "hdc/package/llama-cpp-install.mjs";

import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/llama-cpp/config.example.json";
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
 * @param {ReturnType<typeof resolveLlamaCppDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function maintainLxcOne(deployment, flags, vaultAccess) {
  const { systemId, proxmox: px, install, server } = deployment;
  const skipRestart = flagGet(flags, "skip-restart", "skip_restart") !== undefined;

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, message: "invalid vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} LXC on ${hostId} vmid ${vmid} …\n`);
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const serverCfg = isObject(server) ? server : {};
  const installResult = await installLlamaCppInCt(
    pveSsh.user,
    pveSsh.host,
    vmid,
    install,
    serverCfg,
  );
  if (!installResult.ok) {
    return { ok: false, system_id: systemId, host_id: hostId, install: installResult };
  }

  if (!skipRestart) {
    errout.write(`[hdc] ${target} ${verb}: restarting llama-server on ${systemId} …\n`);
    const r = pctExec(
      pveSsh.user,
      pveSsh.host,
      vmid,
      "systemctl restart llama-server 2>/dev/null || systemctl start llama-server 2>/dev/null || true",
    );
    if (r.status !== 0) {
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        message: `restart failed (exit ${r.status})`,
        install: installResult,
      };
    }
  }

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

  return {
    ok: baseline.ok,
    system_id: systemId,
    host_id: hostId,
    mode: deployment.mode,
    install: installResult,
    restarted: !skipRestart,
    ...guestBaselineResultFields(baseline),
  };
}

/**
 * @param {ReturnType<typeof resolveLlamaCppDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function maintainQemuOne(deployment, flags, vaultAccess) {
  const { systemId, mode, proxmox: px, configure, install, server } = deployment;
  const skipRestart = flagGet(flags, "skip-restart", "skip_restart") !== undefined;
  const log = provisionLogFromConsole(console);

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const sshUser = resolveGuestSshUser(sshCfg.user);
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];
  if (!sshHost) {
    return { ok: false, system_id: systemId, message: "configure.ssh.host or proxmox.qemu.ip required" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} QEMU via ${sshUser}@${sshHost} …\n`);
  const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
  const serverCfg = isObject(server) ? server : {};
  let installResult;
  try {
    installResult = await installLlamaCppViaSsh({ exec, log, install, server: serverCfg });
  } catch (e) {
    return {
      ok: false,
      system_id: systemId,
      message: String(/** @type {Error} */ (e).message || e),
    };
  }
  if (!installResult.ok) {
    return { ok: false, system_id: systemId, install: installResult };
  }

  if (!skipRestart) {
    errout.write(`[hdc] ${target} ${verb}: restarting llama-server on ${systemId} …\n`);
    const r = exec.run(
      "systemctl restart llama-server 2>/dev/null || systemctl start llama-server 2>/dev/null || true",
      { capture: true },
    );
    if (r.status !== 0) {
      return {
        ok: false,
        system_id: systemId,
        message: `restart failed (exit ${r.status})`,
        install: installResult,
      };
    }
  }

  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags,
    vaultAccess,
    deployment,
    proxmoxPackageRoot: proxmoxRoot,
  });

  return {
    ok: baseline.ok,
    system_id: systemId,
    mode,
    install: installResult,
    restarted: !skipRestart,
    ...guestBaselineResultFields(baseline),
  };
}

/**
 * @param {ReturnType<typeof resolveLlamaCppDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function maintainOne(deployment, flags, vaultAccess) {
  if (deployment.mode === "proxmox-qemu") {
    return maintainQemuOne(deployment, flags, vaultAccess);
  }
  if (deployment.mode === "proxmox-lxc") {
    return maintainLxcOne(deployment, flags, vaultAccess);
  }
  return { ok: false, system_id: deployment.systemId, message: `unsupported mode ${deployment.mode}` };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: upgrade llama-server binaries (stderr log; JSON on stdout).\n`);

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
  let deployments;
  try {
    deployments = resolveLlamaCppDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (deployments.length > 1) {
    errout.write(`[hdc] ${target} ${verb}: maintaining ${deployments.length} instance(s) …\n`);
  }

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
