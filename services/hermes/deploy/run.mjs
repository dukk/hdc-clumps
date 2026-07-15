#!/usr/bin/env node
/**
 * Deploy Hermes Agent on Proxmox LXC or QEMU Ubuntu VM (Docker Compose).
 *
 * Usage: hdc run service hermes deploy -- [--instance a | --system-id hermes-a] [--skip-install]
 *        hdc run service hermes deploy -- [--skip-existing | --redeploy-existing | --destroy-existing]
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
import { ensureQemuGuestAgentOnDeploy } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-install.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { waitForLxcCreateTaskAndApplyResources } from "../../../infrastructure/proxmox/lib/proxmox-lxc-post-create.mjs";
import { ensureLxcStarted } from "../../../infrastructure/proxmox/lib/proxmox-lxc-start.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { resolveProvisionVmid } from "../../../infrastructure/proxmox/lib/proxmox-vmid-conflict.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";

import { dashboardPort, resolveHermesDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import {
  installHermesInCt,
  installHermesInQemu,
  readCtPrimaryIp,
  resolvePveSshForHost,
} from "hdc/package/hermes-install.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  waitForQemuGuestSshAfterBoot,
} from "../../ollama/lib/proxmox-qemu-redeploy.mjs";
import { resolveDashboardUrl } from "hdc/package/hermes-render.mjs";
import {
  ensureLxcDockerApparmorWorkaround,
  pctRestart,
  pctSetFeatures,
} from "hdc/package/pve-pct-remote.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { createHermesVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolveHermesSecrets } from "hdc/package/vault-secrets.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/hermes/config.example.json";
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
 * @param {Record<string, unknown>} install
 */
function shouldInstall(install) {
  return install.enabled !== false;
}

/**
 * @param {Record<string, string>} flags
 */
function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  if (flagGet(flags, "destroy-existing") !== undefined) return "destroy";
  return "prompt";
}

function skipProvision(flags) {
  return flagGet(flags, "skip-provision") !== undefined;
}

/**
 * @param {ReturnType<typeof resolveHermesDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {ReturnType<typeof createHermesVaultAccess>} vault
 */
async function deployQemuOne(deployment, flags, log, vault) {
  const { mode, systemId, hostname, proxmox: px, configure, hermes, install } = deployment;

  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: ${JSON.stringify(systemId)} proxmox-qemu on ${JSON.stringify(hostId)} …\n`,
  );
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });

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
  const guestName =
    hostname ||
    (typeof q.hostname === "string" && q.hostname.trim()
      ? q.hostname.trim()
      : systemId.replace(/^vm-/, ""));

  if (!Number.isFinite(vmid) || vmid <= 0 || !Number.isFinite(templateVmid) || templateVmid <= 0 || !ip) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid qemu vmid, template_vmid, or ip" };
  }

  const located = await locateGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  const policy = existingGuestPolicy(flags);
  let skipProv = skipProvision(flags);

  if (located) {
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    }
    if (action === "skip") {
      errout.write(`[hdc] ${target} ${verb}: skipping ${systemId} (vmid ${vmid} already exists).\n`);
      return {
        ok: true,
        system_id: systemId,
        host_id: hostId,
        mode,
        skipped: true,
        message: "guest already exists",
        guest: { vmid, node: located.node, name: located.name },
      };
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
      errout.write(
        `[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} exists — redeploy (provision skipped, install only).\n`,
      );
      skipProv = true;
    }
  }

  /** @type {import("../../../lib/host-provisioner.mjs").ProvisionResult | null} */
  let provisionResult = null;
  /** @type {Record<string, unknown> | null} */
  let installResult = null;
  let cloneNode = located?.node ?? auth.host.pveNode;
  let guestVmid = vmid;

  if (!skipProv) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,    });

    provisionResult = await cloneQemuGuest({
      log,
      provisioner: prov,
      name: guestName,
      vmid,
      templateVmid,
      parameters: { ...q, vmid, template_vmid: templateVmid },
    });

    if (!provisionResult.ok) {
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
      };
    }

    const cloneInfo = await waitForCloneTaskAndEnableAgent(
      provisionResult,
      auth,
      vmid,
      (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      guestResourceOptsFromBlock(q, flags),
    );
    cloneNode = cloneInfo.node;
    guestVmid = cloneInfo.vmid;

    const rootfsGb = typeof q.rootfs_gb === "number" ? q.rootfs_gb : Number(q.rootfs_gb);
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    if (Number.isFinite(rootfsGb) && rootfsGb > 0) {
      errout.write(`[hdc] ${target} ${verb}: resizing scsi0 to ${rootfsGb}G on vmid ${guestVmid} …\n`);
      const resize = sshRemote(pveSsh.user, pveSsh.host, `qm resize ${guestVmid} scsi0 ${rootfsGb}G`, {
        capture: true,
      });
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
      hostname: guestName,
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
  } else if (located) {
    provisionResult = {
      ok: true,
      message: `QEMU ${vmid} already present on ${located.node}`,
      details: { vmid, node: located.node, type: "qemu", skipped_provision: true },
    };
    cloneNode = located.node;
    guestVmid = vmid;
    await startQemuGuest({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: cloneNode,
      vmid: guestVmid,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
  }

  const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
  let sshUser = resolveGuestSshUser(sshCfg.user);
  const guestIp = ip.split("/")[0];
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : guestIp;

  const hermesCfg = isObject(hermes) ? hermes : {};
  const installCfg = isObject(install) ? install : {};

  if (shouldInstall(install)) {
    if (!skipProv) {
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
    } else {
      const sshWait = await waitForQemuGuestSshAfterBoot({
        user: sshUser,
        host: sshHost,
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: cloneNode,
        vmid: guestVmid,
        freshClone: false,
        proxmoxPackageRoot: proxmoxRoot,
        flags,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      sshUser = sshWait.user;
    }

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

    errout.write(`[hdc] ${target} ${verb}: resolving vault secrets for ${systemId} …\n`);
    const secrets = await resolveHermesSecrets(vault, hermesCfg);
    const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
    installResult = await installHermesInQemu({ exec, hermes: hermesCfg, install: installCfg, secrets, guestIp });
  } else {
    installResult = { ok: true, message: "skipped" };
    errout.write(`[hdc] ${target} ${verb}: install skipped for ${systemId}.\n`);
  }

  const dashboardUrl = resolveDashboardUrl(hermesCfg, guestIp) ?? installResult?.dashboard_url ?? null;
  const ok = provisionResult?.ok !== false && installResult?.ok !== false;

  return {
    ok,
    system_id: systemId,
    host_id: hostId,
    mode,
    redeploy: skipProv,
    ip: guestIp,
    dashboard_url: dashboardUrl,
    dashboard_port: dashboardPort(hermesCfg),
    result: provisionResult,
    install: installResult,
    ssh: { user: sshUser, host: sshHost },
  };
}

/**
 * @param {ReturnType<typeof resolveHermesDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null }; vault: ReturnType<typeof createHermesVaultAccess> }} runOpts
 */
async function deployLxcOne(deployment, flags, log, runOpts) {
  const { mode, systemId, proxmox: px, hermes, install } = deployment;

  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: ${JSON.stringify(systemId)} on ${JSON.stringify(hostId)} mode ${JSON.stringify(mode)} …\n`,
  );
  errout.write(`[hdc] ${target} ${verb}: authorizing Proxmox API for host ${JSON.stringify(hostId)} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });

  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );

  let skipProvision = false;
  if (located) {
    const policy = existingGuestPolicy(flags);
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    }
    if (action === "skip") {
      errout.write(`[hdc] ${target} ${verb}: skipping ${systemId} (vmid ${vmid} already exists).\n`);
      return {
        ok: true,
        system_id: systemId,
        host_id: hostId,
        mode,
        skipped: true,
        message: "guest already exists",
        guest: { vmid, node: located.node, name: located.name },
      };
    }
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} exists — redeploy (provision skipped, install only).\n`,
    );
    skipProvision = true;
  }

  /** @type {import("../../../lib/host-provisioner.mjs").ProvisionResult | null} */
  let provisionResult = null;
  /** @type {{ ok: boolean; method?: string; message?: string; dashboard_url?: string | null } | null} */
  let installResult = null;

  if (!skipProvision) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,    });
    const hostname =
      (typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
      lxcHostnameFromSystemId(systemId) ||
      "hermes";
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
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        message: String(/** @type {Error} */ (e).message || e),
      };
    }
    /** @type {Record<string, unknown>} */
    const parameters = { ...lxc, password: rootPassword };
    provisionResult = await prov.createContainer(log, {
      name: hostname,
      memoryMb,
      cores,
      diskGb,
      parameters,
    });
    if (!provisionResult.ok) {
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
      };
    }
  } else {
    provisionResult = {
      ok: true,
      message: `LXC ${vmid} already present on ${located?.node ?? "?"}`,
      details: { vmid, node: located?.node, type: "lxc", skipped_provision: true },
    };
  }

  const guestVmid = resolveProvisionVmid(provisionResult, vmid);

  const lxcNode =
    (typeof provisionResult.details?.node === "string" && provisionResult.details.node.trim()) ||
    located?.node ||
    auth.host.pveNode;

  await waitForLxcCreateTaskAndApplyResources(
    provisionResult,
    auth,
    vmid,
    (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    guestResourceOptsFromBlock(lxc, flags),
  );

  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const unprivileged =
    lxc.unprivileged === undefined ? 1 : Number(lxc.unprivileged) === 0 ? 0 : 1;
  const lxcFeatures = typeof lxc.features === "string" ? lxc.features.trim() : "";
  if (unprivileged === 0 && lxcFeatures) {
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId}: applying LXC features via pct on ${pveSsh.host} …\n`,
    );
    const fr = pctSetFeatures(pveSsh.user, pveSsh.host, guestVmid, lxcFeatures, { capture: true });
    if (fr.status !== 0) {
      const msg = `pct set -features failed (exit ${fr.status}): ${(fr.stderr || fr.stdout).trim()}`;
      errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${msg}\n`);
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
        message: msg,
      };
    }
  }

  if (unprivileged === 0) {
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId}: ensuring Docker AppArmor workaround on ${pveSsh.host} …\n`,
    );
    const ar = ensureLxcDockerApparmorWorkaround(pveSsh.user, pveSsh.host, guestVmid, {
      capture: true,
    });
    if (ar.status !== 0) {
      const msg = `LXC AppArmor workaround failed (exit ${ar.status}): ${(ar.stderr || ar.stdout).trim()}`;
      errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${msg}\n`);
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
        message: msg,
      };
    }
    if (/changed=1/.test(ar.stdout)) {
      errout.write(
        `[hdc] ${target} ${verb}: ${systemId}: restarting CT ${guestVmid} to apply LXC config …\n`,
      );
      const rr = pctRestart(pveSsh.user, pveSsh.host, guestVmid, { capture: true });
      if (rr.status !== 0) {
        const msg = `pct restart failed (exit ${rr.status}): ${(rr.stderr || rr.stdout).trim()}`;
        return {
          ok: false,
          system_id: systemId,
          host_id: hostId,
          mode,
          result: provisionResult,
          message: msg,
        };
      }
    }
  }

  const hermesCfg = isObject(hermes) ? hermes : {};
  const installCfg = isObject(install) ? install : {};

  if (shouldInstall(install)) {
    try {
      await ensureLxcStarted({
        apiBase: auth.host.apiBase,
        node: lxcNode,
        vmid: guestVmid,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
        message: msg,
      };
    }
  }

  if (shouldInstall(install)) {
    const secrets = await resolveHermesSecrets(runOpts.vault, hermesCfg);
    installResult = await installHermesInCt(
      pveSsh.user,
      pveSsh.host,
      guestVmid,
      hermesCfg,
      installCfg,
      secrets,
    );
  } else {
    installResult = { ok: true, method: "skipped", message: "skipped" };
    errout.write(`[hdc] ${target} ${verb}: install skipped for ${systemId}.\n`);
  }

  if (!installResult.ok) {
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      mode,
      redeploy: skipProvision,
      result: provisionResult,
      install: installResult,
    };
  }

  const ip = readCtPrimaryIp(pveSsh.user, pveSsh.host, guestVmid);
  const dashboardUrl = resolveDashboardUrl(hermesCfg, ip) ?? installResult.dashboard_url ?? null;

  return {
    ok: provisionResult.ok && installResult.ok,
    system_id: systemId,
    host_id: hostId,
    mode,
    redeploy: skipProvision,
    ip,
    dashboard_url: dashboardUrl,
    dashboard_port: dashboardPort(hermesCfg),
    result: provisionResult,
    install: installResult,
  };
}

/**
 * @param {ReturnType<typeof resolveHermesDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null }; vault: ReturnType<typeof createHermesVaultAccess> }} runOpts
 */
async function deployOne(deployment, flags, log, runOpts) {
  if (deployment.mode === "proxmox-qemu") {
    return deployQemuOne(deployment, flags, log, runOpts.vault);
  }
  if (deployment.mode === "proxmox-lxc") {
    return deployLxcOne(deployment, flags, log, runOpts);
  }
  return { ok: false, system_id: deployment.systemId, message: `unsupported mode ${deployment.mode}` };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Hermes Agent via Proxmox (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    const inv = deployTargetInventory(root, target);
    logDeployInventoryStatus(target, verb, inv);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));

  /** @type {ReturnType<typeof resolveHermesDeployments>} */
  let deployments;
  try {
    deployments = resolveHermesDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createHermesVaultAccess();
  await vault.unlock({});

  const log = provisionLogFromConsole(console);
  /** @type {{ value: string | null }} */
  const ctPasswordCache = { value: null };
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await deployOne(deployment, flags, log, { ctPasswordCache, vault }));
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
