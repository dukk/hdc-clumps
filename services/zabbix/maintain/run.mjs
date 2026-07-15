#!/usr/bin/env node
/**
 * Maintain Zabbix: refresh docker stack and guest baseline.
 *
 * Usage: hdc run service zabbix maintain -- [--instance a | --system-id vm-zabbix-a] [--skip-upgrade] [--skip-clamav]
 */
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { resolveZabbixDeployments } from "hdc/package/deployments.mjs";
import { maintainZabbixInCt, maintainZabbixOnHost, resolvePveSshForHost } from "hdc/package/zabbix-install.mjs";
import { createZabbixVaultAccess, resolveZabbixDbSecrets } from "hdc/package/vault-deps.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/zabbix/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let pkgConfig = null;
function ensurePackageConfig() {
  if (!pkgConfig) pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
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
 * @param {ReturnType<typeof resolveZabbixDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof createZabbixVaultAccess>} vaultAccess
 * @param {{ dbPassword: string; dbRootPassword: string }} passwords
 */
async function maintainOne(deployment, flags, vaultAccess, passwords) {
  const { systemId, mode, proxmox: px, zabbix, install, configure } = deployment;
  if (!isObject(px)) return { ok: false, system_id: systemId, message: "bad proxmox config" };
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return { ok: false, system_id: systemId, message: "missing host_id" };

  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  const zabbixCfg = isObject(zabbix) ? zabbix : {};
  const installCfg = isObject(install) ? install : {};

  /** @type {{ ok: boolean; message?: string }} */
  let result;

  if (mode === "proxmox-qemu") {
    const cfg = isObject(configure) ? configure : {};
    const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
    if (!host) return { ok: false, system_id: systemId, message: "configure.ssh.host required" };
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} on ${hostId} (QEMU) …\n`);
    const exec = createConfigureExec("ssh", { user, host });
    result = await maintainZabbixOnHost(exec, zabbixCfg, installCfg, passwords.dbPassword, passwords.dbRootPassword, {
      skipUpgrade,
    });
  } else {
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) return { ok: false, system_id: systemId, message: "missing vmid" };
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    result = await maintainZabbixInCt(
      pveSsh.user,
      pveSsh.host,
      vmid,
      zabbixCfg,
      installCfg,
      passwords.dbPassword,
      passwords.dbRootPassword,
      { skipUpgrade },
    );
  }

  const log = provisionLogFromConsole(console);

  let baseline;
  if (mode === "proxmox-qemu") {
    const cfg = isObject(configure) ? configure : {};
    const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
    const exec = createConfigureExec("ssh", { user, host });
    baseline = await ensureGuestLinuxBaseline({
      exec,
      log,
      flags,
      vaultAccess,
      deployment,
      proxmoxPackageRoot: proxmoxRoot,
    });
  } else {
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    const exec = createConfigureExec("pct", { user: pveSsh.user, host: pveSsh.host, vmid, pveHost: pveSsh.host });
    baseline = await ensureGuestLinuxBaseline({
      exec,
      log,
      flags,
      vaultAccess,
      deployment,
      proxmoxPackageRoot: proxmoxRoot,
    });
  }

  const vmidRaw =
    mode === "proxmox-qemu"
      ? (() => {
          const q = isObject(px.qemu) ? px.qemu : {};
          return typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
        })()
      : (() => {
          const lxc = isObject(px.lxc) ? px.lxc : {};
          return typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
        })();

  return {
    ok: result.ok && baseline.ok,
    system_id: systemId,
    host_id: hostId,
    mode,
    vmid: vmidRaw,
    ...result,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh Zabbix stack (stderr log; JSON on stdout).\n`);
  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: "clump config missing - see stderr" }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolveZabbixDeployments(cfg, flags);
  } catch (e) {
    const message = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const defaultsZabbix = isObject(cfg.defaults) && isObject(cfg.defaults.zabbix) ? cfg.defaults.zabbix : {};
  const vaultAccess = createZabbixVaultAccess();
  const { dbPassword, dbRootPassword } = await resolveZabbixDbSecrets(vaultAccess, defaultsZabbix);
  if (!dbPassword) {
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: "missing zabbix db vault secret" }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainOne(deployment, flags, vaultAccess, { dbPassword, dbRootPassword }));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
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
