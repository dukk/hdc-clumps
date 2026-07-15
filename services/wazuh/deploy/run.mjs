#!/usr/bin/env node
/**
 * Deploy Wazuh on Proxmox LXC or QEMU (Docker Compose).
 *
 * Usage: hdc run service wazuh deploy -- [--instance a | --system-id vm-wazuh-a] [--skip-install]
 *        hdc run service wazuh deploy -- [--skip-existing | --redeploy-existing | --destroy-existing]
 */
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { lxcHostnameFromSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForLxcCreateTaskAndApplyResources } from "../../../infrastructure/proxmox/lib/proxmox-lxc-post-create.mjs";
import { ensureLxcStarted } from "../../../infrastructure/proxmox/lib/proxmox-lxc-start.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { resolveProvisionVmid } from "../../../infrastructure/proxmox/lib/proxmox-vmid-conflict.mjs";
import { ensureQemuGuestAgentOnDeploy } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-install.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";

import { resolveWazuhDeployments, wazuhApiPasswordVaultKey, wazuhAgentPasswordVaultKey } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { wazuhManagerAlertsSkippedByFlags } from "hdc/package/wazuh-manager-alerts.mjs";
import { wazuhAlertIgnoreSkippedByFlags } from "hdc/package/wazuh-alert-ignore.mjs";
import {
  installWazuhInCt,
  installWazuhOnHost,
  readCtPrimaryIp,
  resolvePveSshForHost,
} from "hdc/package/wazuh-install.mjs";
import { resolveWazuhMailConfig } from "hdc/package/wazuh-mail-config.mjs";
import { ensureLxcDockerApparmorWorkaround, pctRestart, pctSetFeatures } from "hdc/package/pve-pct-remote.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { createWazuhVaultAccess } from "hdc/package/vault-deps.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  waitForQemuGuestSshAfterBoot,
} from "hdc/package/proxmox-qemu-redeploy.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/wazuh/config.example.json";
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
/** @param {Record<string, unknown>} install */
function shouldInstall(install) {
  return install.enabled !== false;
}
/** @param {Record<string, string>} flags */
function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  if (flagGet(flags, "destroy-existing") !== undefined) return "destroy";
  return "prompt";
}

/**
 * @param {ReturnType<typeof resolveWazuhDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {{ apiPassword: string; agentPassword: string; mailSettings: import("../lib/wazuh-mail-config.mjs").WazuhMailSettings | null; skipMail?: boolean; skipAlertIgnore?: boolean }} runOpts
 */
async function runConfigure(deployment, flags, runOpts) {
  const { systemId, mode, wazuh, install, configure } = deployment;
  const wazuhCfg = isObject(wazuh) ? wazuh : {};
  const installCfg = isObject(install) ? install : {};
  if (!shouldInstall(installCfg)) {
    return { ok: true, skipped: true, message: "install disabled" };
  }
  const installOpts = {
    mailSettings: runOpts.mailSettings,
    skipMail: runOpts.skipMail,
    skipAlertIgnore: runOpts.skipAlertIgnore,
  };
  if (mode === "proxmox-lxc") {
    const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    return installWazuhInCt(
      pveSsh.user,
      pveSsh.host,
      vmid,
      wazuhCfg,
      installCfg,
      runOpts.apiPassword,
      runOpts.agentPassword,
      installOpts,
    );
  }
  const cfg = isObject(configure) ? configure : {};
  const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
  if (!host) throw new Error(`${systemId}: configure.ssh.host required`);
  const exec = createConfigureExec("ssh", { user, host });
  return installWazuhOnHost(exec, wazuhCfg, installCfg, runOpts.apiPassword, runOpts.agentPassword, installOpts);
}

/**
 * @param {ReturnType<typeof resolveWazuhDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null }; apiPassword: string; agentPassword: string }} runOpts
 */
async function deployLxcOne(deployment, flags, log, runOpts) {
  const { mode, systemId, proxmox: px, wazuh, install } = deployment;
  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);
  if (!isObject(px)) return { ok: false, system_id: systemId, message: "bad proxmox config" };
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return { ok: false, system_id: systemId, message: "missing host_id" };

  errout.write(`[hdc] ${target} ${verb}: ${JSON.stringify(systemId)} on ${JSON.stringify(hostId)} (LXC) …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };

  const located = await findClusterGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  let skipProvision = false;
  if (located) {
    const policy = existingGuestPolicy(flags);
    let action = policy;
    if (policy === "prompt") action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    if (action === "skip") {
      return { ok: true, system_id: systemId, host_id: hostId, mode, skipped: true, message: "guest already exists" };
    }
    skipProvision = true;
  }

  /** @type {import("../../../lib/host-provisioner.mjs").ProvisionResult | null} */
  let provisionResult = null;
  if (!skipProvision) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
    });
    const hostname = (typeof lxc.hostname === "string" && lxc.hostname.trim()) || lxcHostnameFromSystemId(systemId) || "wazuh";
    const memoryMb = typeof lxc.memory_mb === "number" ? lxc.memory_mb : Number(lxc.memory_mb);
    const cores = typeof lxc.cores === "number" ? lxc.cores : Number(lxc.cores);
    const diskGb = typeof lxc.rootfs_gb === "number" ? lxc.rootfs_gb : Number(lxc.rootfs_gb);
    if (![memoryMb, cores, diskGb].every((n) => Number.isFinite(n) && n > 0)) {
      return { ok: false, system_id: systemId, host_id: hostId, message: "invalid lxc sizing fields" };
    }
    const cache = runOpts.ctPasswordCache ?? { value: null };
    let rootPassword;
    try {
      rootPassword = await resolveLxcRootPassword(systemId, vmid, lxc, flags, {
        cached: cache.value,
        setCached: (v) => {
          cache.value = v;
        },
      });
    } catch (e) {
      return { ok: false, system_id: systemId, host_id: hostId, message: String(/** @type {Error} */ (e).message || e) };
    }
    provisionResult = await prov.createContainer(log, {
      name: hostname,
      memoryMb,
      cores,
      diskGb,
      parameters: { ...lxc, password: rootPassword },
    });
    if (!provisionResult.ok) return { ok: false, system_id: systemId, host_id: hostId, mode, result: provisionResult };
  } else {
    provisionResult = {
      ok: true,
      message: `LXC ${vmid} already present`,
      details: { vmid, node: located?.node, type: "lxc", skipped_provision: true },
    };
  }

  const guestVmid = resolveProvisionVmid(provisionResult, vmid);
  const lxcNode = (typeof provisionResult.details?.node === "string" && provisionResult.details.node.trim()) || located?.node || auth.host.pveNode;
  await waitForLxcCreateTaskAndApplyResources(
    provisionResult,
    auth,
    vmid,
    (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    guestResourceOptsFromBlock(lxc, flags),
  );

  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const unprivileged = lxc.unprivileged === undefined ? 1 : Number(lxc.unprivileged) === 0 ? 0 : 1;
  const lxcFeatures = typeof lxc.features === "string" ? lxc.features.trim() : "";
  if (unprivileged === 0 && lxcFeatures) {
    const fr = pctSetFeatures(pveSsh.user, pveSsh.host, guestVmid, lxcFeatures, { capture: true });
    if (fr.status !== 0) return { ok: false, system_id: systemId, host_id: hostId, mode, message: `pct set -features failed (exit ${fr.status})` };
  }
  if (unprivileged === 0) {
    const ar = ensureLxcDockerApparmorWorkaround(pveSsh.user, pveSsh.host, guestVmid, { capture: true });
    if (ar.status !== 0) return { ok: false, system_id: systemId, host_id: hostId, mode, message: `LXC AppArmor workaround failed (exit ${ar.status})` };
    if (/changed=1/.test(ar.stdout)) {
      const rr = pctRestart(pveSsh.user, pveSsh.host, guestVmid, { capture: true });
      if (rr.status !== 0) return { ok: false, system_id: systemId, host_id: hostId, mode, message: `pct restart failed (exit ${rr.status})` };
    }
  }

  if (shouldInstall(install)) {
    await ensureLxcStarted({
      apiBase: auth.host.apiBase,
      node: lxcNode,
      vmid: guestVmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    });
  }

  const installResult = shouldInstall(install)
    ? await installWazuhInCt(
        pveSsh.user,
        pveSsh.host,
        guestVmid,
        isObject(wazuh) ? wazuh : {},
        isObject(install) ? install : {},
        runOpts.apiPassword,
        runOpts.agentPassword,
        { mailSettings: runOpts.mailSettings, skipMail: runOpts.skipMail, skipAlertIgnore: runOpts.skipAlertIgnore },
      )
    : { ok: true, method: "skipped", message: "skipped" };
  if (!installResult.ok) return { ok: false, system_id: systemId, host_id: hostId, mode, result: provisionResult, install: installResult };
  const ip = readCtPrimaryIp(pveSsh.user, pveSsh.host, guestVmid);
  return {
    ok: true,
    system_id: systemId,
    host_id: hostId,
    mode,
    redeploy: skipProvision,
    ip,
    result: provisionResult,
    install: installResult,
  };
}

/**
 * @param {ReturnType<typeof resolveWazuhDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ apiPassword: string; agentPassword: string }} runOpts
 */
async function deployQemuOne(deployment, flags, log, runOpts) {
  const { systemId, proxmox: px, wazuh, install } = deployment;
  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);
  if (!isObject(px)) return { ok: false, system_id: systemId, message: "missing proxmox config" };
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return { ok: false, system_id: systemId, message: "missing host_id" };

  const q = isObject(px.qemu) ? px.qemu : {};
  const net = isObject(px.network) ? px.network : {};
  const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
  const templateVmid = typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid);
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const gateway =
    typeof net.gateway === "string" && net.gateway.trim()
      ? net.gateway.trim()
      : typeof q.gateway === "string"
        ? q.gateway.trim()
        : "192.0.2.1";
  const hostname =
    deployment.hostname ||
    (typeof q.name === "string" && q.name.trim() ? q.name.trim() : systemId.replace(/^vm-/, ""));
  const rootfsGb = typeof q.rootfs_gb === "number" ? q.rootfs_gb : Number(q.rootfs_gb);

  if (!Number.isFinite(vmid) || vmid <= 0 || !Number.isFinite(templateVmid) || templateVmid <= 0 || !ip) {
    return { ok: false, system_id: systemId, message: "invalid qemu vmid, template_vmid, or ip" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${hostId} vmid ${vmid} (QEMU) …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await locateGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  const policy = existingGuestPolicy(flags);

  if (located) {
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    }
    if (action === "skip") {
      return { ok: true, system_id: systemId, skipped_provision: true, message: "guest already exists" };
    }
    if (action === "destroy" || policy === "destroy") {
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
    } else {
      const configure = await runConfigure(deployment, flags, runOpts);
      return {
        ok: configure.ok !== false,
        system_id: systemId,
        skipped_provision: true,
        configure,
        ip: (() => {
          const cfg = isObject(deployment.configure) ? deployment.configure : {};
          const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
          return typeof ssh.host === "string" ? ssh.host.trim() : ip.split("/")[0];
        })(),
      };
    }
  }

  const prov = createProxmoxHostProvisioner({
    apiBase: auth.host.apiBase,
    pveNode: auth.host.pveNode,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    clumpId: target,
  });

  const provisionResult = await cloneQemuGuest({
    log,
    provisioner: prov,
    name: hostname,
    vmid,
    templateVmid,
    parameters: { ...q, vmid, template_vmid: templateVmid },
  });
  if (!provisionResult.ok) {
    return { ok: false, system_id: systemId, provision: provisionResult };
  }

  const { node: cloneNode, vmid: guestVmid } = await waitForCloneTaskAndEnableAgent(
    provisionResult,
    auth,
    vmid,
    (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    guestResourceOptsFromBlock(q, flags),
  );

  if (Number.isFinite(rootfsGb) && rootfsGb > 0) {
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    errout.write(`[hdc] ${target} ${verb}: resizing scsi0 to ${rootfsGb}G on vmid ${guestVmid} …\n`);
    const resize = sshRemote(pveSsh.user, pveSsh.host, `qm resize ${guestVmid} scsi0 ${rootfsGb}G`, { capture: true });
    if (resize.status !== 0) {
      const detail = `${resize.stderr}${resize.stdout}`.trim() || `exit ${resize.status}`;
      throw new Error(`qm resize failed: ${detail}`);
    }
  }

  await applyQemuCloudInit({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: cloneNode,
    vmid: guestVmid,
    hostname,
    ipCidr: ip,
    gateway,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  await startQemuGuest({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: cloneNode,
    vmid: guestVmid,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  const sshCfg = isObject(deployment.configure) && isObject(deployment.configure.ssh) ? deployment.configure.ssh : {};
  let sshUser = resolveGuestSshUser(sshCfg.user);
  const sshHost = typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];

  const sshWait = await waitForQemuGuestSshAfterBoot({
    user: sshUser,
    host: sshHost,
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: cloneNode,
    vmid: guestVmid,
    freshClone: true,
    proxmoxPackageRoot: proxmoxRoot,
    flags,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
  sshUser = sshWait.user;

  await ensureQemuGuestAgentOnDeploy({
    apiBase: auth.host.apiBase,
    node: cloneNode,
    vmid: guestVmid,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    sshUser,
    sshHost,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  const configure = await runConfigure(
    {
      ...deployment,
      configure: { ssh: { user: sshUser, host: sshHost } },
    },
    flags,
    runOpts,
  );

  return {
    ok: configure.ok !== false,
    system_id: systemId,
    mode: "proxmox-qemu",
    ip: sshHost,
    provision: provisionResult,
    configure,
    install: configure,
  };
}

/**
 * @param {ReturnType<typeof resolveWazuhDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null }; apiPassword: string; agentPassword: string }} runOpts
 */
async function deployOne(deployment, flags, log, runOpts) {
  if (deployment.mode === "proxmox-qemu") {
    return deployQemuOne(deployment, flags, log, runOpts);
  }
  if (deployment.mode === "proxmox-lxc") {
    return deployLxcOne(deployment, flags, log, runOpts);
  }
  return { ok: false, system_id: deployment.systemId, message: `unsupported mode ${deployment.mode}` };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Wazuh via Proxmox (stderr log; JSON on stdout).\n`);
  if (!existsSync(ensurePackageConfig().path)) {
    const inv = deployTargetInventory(root, target);
    logDeployInventoryStatus(target, verb, inv);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: "clump config missing - see stderr" }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolveWazuhDeployments(cfg, flags);
  } catch (e) {
    const message = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const defaultsWazuh = isObject(cfg.defaults) && isObject(cfg.defaults.wazuh) ? cfg.defaults.wazuh : {};
  const apiKeyName = wazuhApiPasswordVaultKey(defaultsWazuh);
  const agentKeyName = wazuhAgentPasswordVaultKey(defaultsWazuh);
  const vault = createWazuhVaultAccess();
  await vault.unlock({});
  const apiPassword = String(await vault.getSecret(apiKeyName, { promptLabel: `vault secret ${apiKeyName}` })).trim();
  const agentPassword = String(await vault.getSecret(agentKeyName, { promptLabel: `vault secret ${agentKeyName}` })).trim();
  if (!apiPassword || !agentPassword) {
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: "missing wazuh vault secrets" }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const skipMail = wazuhManagerAlertsSkippedByFlags(flags);
  const skipAlertIgnore = wazuhAlertIgnoreSkippedByFlags(flags);
  const mailSettings = skipMail ? null : resolveWazuhMailConfig(cfg);

  const log = provisionLogFromConsole(console);
  /** @type {{ value: string | null }} */
  const ctPasswordCache = { value: null };
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(
        await deployOne(deployment, flags, log, {
          ctPasswordCache,
          apiPassword,
          agentPassword,
          mailSettings,
          skipMail,
          skipAlertIgnore,
        }),
      );
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
