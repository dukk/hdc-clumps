#!/usr/bin/env node
/**
 * Deploy Keepalived VRRP/LVS directors and real-server prep.
 *
 * Usage: hdc run service keepalived deploy -- [--instance a | --system-id vm-keepalived-a]
 *        [--destroy-existing] [--skip-provision] [--skip-install]
 *        [--skip-existing | --redeploy-existing] [--director-only] [--real-server-only]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { ensureQemuGuestAgentOnDeploy } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-install.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { configureKeepalivedDirector, createConfigureExec } from "hdc/package/keepalived-configure.mjs";
import { configureKeepalivedRealServer } from "hdc/package/keepalived-real-server.mjs";
import { resolveKeepalivedAuthPass } from "hdc/package/keepalived-auth.mjs";
import {
  normalizeKeepalivedConfig,
  orderDeploymentsForDeploy,
  resolveKeepalivedDeployments,
  sshHostFromDeployment,
  keepalivedGlobalSettings,
  usesNatLbKind,
} from "hdc/package/deployments.mjs";
import { keepalivedPayloadMeta, keepalivedReportExtraSections } from "hdc/package/keepalived-report.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  waitForQemuGuestSshAfterBoot,
} from "hdc/package/proxmox-qemu-redeploy.mjs";
import { createKeepalivedVaultAccess } from "hdc/package/vault-deps.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import {
  growRootFilesystemInGuest,
  resizeQemuScsi0OnHypervisor,
  resolveRootfsGbFromDeployment,
  syncQemuRootfsOnMaintain,
} from "hdc/package/qemu-rootfs-resize.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/keepalived/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const target = basename(dirname(here));
const verb = basename(here);
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
 * @param {Record<string, string>} flags
 */
function destroyPolicy(flags) {
  return flagGet(flags, "destroy-existing") !== undefined;
}

/**
 * @param {Record<string, string>} flags
 */
function skipProvision(flags) {
  return flagGet(flags, "skip-provision") !== undefined;
}

/**
 * @param {Record<string, string>} flags
 */
function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  if (destroyPolicy(flags)) return "destroy";
  return "prompt";
}

/**
 * @param {object} ctx
 */
async function runDirectorConfigure(ctx) {
  const {
    deployment,
    global,
    authPass,
    vrrpInstances,
    virtualServers,
    enableNatForward,
    log,
  } = ctx;

  if (deployment.install.enabled === false) {
    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} install disabled — skipping configure.\n`);
    return { ok: true, skipped: true, message: "install disabled" };
  }

  const cfg = deployment.configure;
  const ssh = isObject(cfg) && isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
  if (!host) {
    throw new Error(`${deployment.systemId}: configure.ssh.host required`);
  }
  const exec = createConfigureExec("ssh", { user, host });

  return configureKeepalivedDirector({
    exec,
    log,
    global,
    director: deployment,
    vrrpInstances,
    virtualServers,
    authPass,
    restartService: true,
    enableNatForward,
  });
}

/**
 * @param {ReturnType<typeof resolveKeepalivedDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof keepalivedGlobalSettings>} global
 * @param {string} authPass
 * @param {ReturnType<typeof normalizeKeepalivedConfig>} normalized
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
async function deployDirector(deployment, flags, global, authPass, normalized, log) {
  if (deployment.deploymentKind !== "director") {
    return { ok: false, system_id: deployment.systemId, message: "not a director deployment" };
  }

  const inv = deployTargetInventory(root, target, { systemIdOverride: deployment.systemId });
  logDeployInventoryStatus(target, verb, inv);

  const enableNatForward = usesNatLbKind(normalized.virtualServers);

  if (skipProvision(flags) || deployment.mode === "configure-only") {
    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} director configure-only …\n`);
    const configure = await runDirectorConfigure({
      deployment,
      global,
      authPass,
      vrrpInstances: normalized.vrrpInstances,
      virtualServers: normalized.virtualServers,
      enableNatForward,
      log,
    });
    return {
      ok: true,
      system_id: deployment.systemId,
      deployment_kind: "director",
      mode: "configure-only",
      state: deployment.state,
      configure,
    };
  }

  const px = deployment.proxmox;
  if (!isObject(px)) {
    return { ok: false, system_id: deployment.systemId, message: "missing proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: deployment.systemId, message: "missing host_id" };
  }
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
    (typeof q.name === "string" && q.name.trim() ? q.name.trim() : deployment.systemId.replace(/^vm-/, ""));

  if (!Number.isFinite(vmid) || vmid <= 0 || !Number.isFinite(templateVmid) || templateVmid <= 0 || !ip) {
    return { ok: false, system_id: deployment.systemId, message: "invalid qemu vmid, template_vmid, or ip" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: ${deployment.systemId} director (${deployment.state}) on ${hostId} vmid ${vmid} …\n`,
  );
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await locateGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  const policy = existingGuestPolicy(flags);

  if (located) {
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(
        deployment.systemId,
        vmid,
        located.node,
        located.name,
      );
    }
    if (action === "skip") {
      errout.write(`[hdc] ${target} ${verb}: skipping provision for ${deployment.systemId}.\n`);
      return { ok: true, system_id: deployment.systemId, skipped_provision: true };
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
        `[hdc] ${target} ${verb}: guest exists — configure only (use --destroy-existing to rebuild).\n`,
      );
      const diskResize = await syncQemuRootfsOnMaintain({
        proxmoxPackageRoot: proxmoxRoot,
        deployment,
        flags,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      const configure = await runDirectorConfigure({
        deployment,
        global,
        authPass,
        vrrpInstances: normalized.vrrpInstances,
        virtualServers: normalized.virtualServers,
        enableNatForward,
        log,
      });
      return {
        ok: true,
        system_id: deployment.systemId,
        deployment_kind: "director",
        state: deployment.state,
        skipped_provision: true,
        disk_resize: diskResize,
        configure,
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
    return {
      ok: false,
      system_id: deployment.systemId,
      deployment_kind: "director",
      provision: provisionResult,
    };
  }

  const { node: cloneNode, vmid: guestVmid } = await waitForCloneTaskAndEnableAgent(
    provisionResult,
    auth,
    vmid,
    (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    guestResourceOptsFromBlock(q, flags),
  );

  const rootfsGb = resolveRootfsGbFromDeployment(deployment);
  if (rootfsGb) {
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    resizeQemuScsi0OnHypervisor({
      sshUser: pveSsh.user,
      sshHost: pveSsh.host,
      vmid: guestVmid,
      rootfsGb,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
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

  const sshCfg = isObject(deployment.configure) && isObject(deployment.configure.ssh)
    ? deployment.configure.ssh
    : {};
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

  if (rootfsGb) {
    const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
    growRootFilesystemInGuest({ exec, log });
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

  const configure = await runDirectorConfigure({
    deployment: {
      ...deployment,
      configure: { ssh: { user: sshUser, host: sshHost } },
    },
    global,
    authPass,
    vrrpInstances: normalized.vrrpInstances,
    virtualServers: normalized.virtualServers,
    enableNatForward,
    log,
  });

  return {
    ok: true,
    system_id: deployment.systemId,
    deployment_kind: "director",
    state: deployment.state,
    provision: provisionResult,
    configure,
  };
}

/**
 * @param {ReturnType<typeof resolveKeepalivedDeployments>[number]} deployment
 * @param {ReturnType<typeof normalizeKeepalivedConfig>} normalized
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
async function deployRealServer(deployment, normalized, log) {
  if (deployment.deploymentKind !== "real_server") {
    return { ok: false, system_id: deployment.systemId, message: "not a real_server deployment" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} real_server (${deployment.lbKind}) …\n`);

  const cfg = deployment.configure;
  const ssh = isObject(cfg) && isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
  if (!host) {
    return { ok: false, system_id: deployment.systemId, message: "missing ssh host" };
  }

  const exec = createConfigureExec("ssh", { user, host });
  const configure = await configureKeepalivedRealServer({
    exec,
    log,
    deployment,
    virtualServers: normalized.virtualServers,
    vrrpInstances: normalized.vrrpInstances,
  });

  return {
    ok: true,
    system_id: deployment.systemId,
    deployment_kind: "real_server",
    mode: "configure-only",
    configure,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: keepalived deploy (stderr log; JSON on stdout).\n`);

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
  let normalized;
  let toDeploy;
  try {
    normalized = normalizeKeepalivedConfig(cfg);
    toDeploy = orderDeploymentsForDeploy(resolveKeepalivedDeployments(cfg, flags));
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const global = keepalivedGlobalSettings(normalized);
  const vault = createKeepalivedVaultAccess();
  await vault.unlock({});

  const log = provisionLogFromConsole(console);
  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
  errout.write(`[hdc] ${target} ${verb}: resolving VRRP auth_pass (${global.authPassVaultKey}) …\n`);
  const authPass = await resolveKeepalivedAuthPass({ global, vault, log: logLine });

  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const deployment of toDeploy) {
    try {
      if (deployment.deploymentKind === "director") {
        results.push(await deployDirector(deployment, flags, global, authPass, normalized, log));
      } else {
        results.push(await deployRealServer(deployment, normalized, log));
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({
        ok: false,
        system_id: deployment.systemId,
        deployment_kind: deployment.deploymentKind,
        message: msg,
      });
    }
  }

  const ok = results.every((r) => r.ok !== false);
  const hostBySystem = new Map(toDeploy.map((d) => [d.systemId, sshHostFromDeployment(d)]));
  const resultsWithHosts = results.map((r) => {
    const sid = typeof r.system_id === "string" ? r.system_id : "";
    const host = sid ? hostBySystem.get(sid) : "";
    return host ? { ...r, host } : r;
  });
  const payload = {
    ok,
    target,
    verb,
    count: resultsWithHosts.length,
    keepalived: keepalivedPayloadMeta(global),
    vrrp_instance_count: normalized.vrrpInstances.length,
    virtual_server_count: normalized.virtualServers.length,
    results: resultsWithHosts,
  };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: logLine,
    extraSections: keepalivedReportExtraSections,
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
