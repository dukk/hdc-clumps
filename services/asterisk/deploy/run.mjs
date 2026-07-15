#!/usr/bin/env node
/**
 * Deploy Asterisk on Proxmox (LXC or QEMU) or configure-only.
 *
 * Usage: hdc run service asterisk deploy -- [--instance a | --system-id asterisk-a]
 *        [--skip-install] [--skip-existing | --redeploy-existing] [--destroy-existing] [--skip-provision]
 */
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
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import {
  growRootFilesystemInGuest,
  resizeQemuScsi0OnHypervisor,
  resolveRootfsGbFromDeployment,
  syncQemuRootfsOnMaintain,
} from "hdc/package/qemu-rootfs-resize.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  waitForQemuGuestSshAfterBoot,
} from "../../step-ca/lib/proxmox-qemu-redeploy.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import { resolveAsteriskDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { readCtPrimaryIp } from "hdc/package/asterisk-install.mjs";
import { configureAsteriskServer, createConfigureExec, resolveConfigureExec } from "hdc/package/asterisk-configure.mjs";
import { sipPort, twilioEnabled } from "hdc/package/asterisk-render.mjs";
import { createAsteriskVaultAccess, resolveAsteriskSecrets } from "hdc/package/asterisk-vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/asterisk/config.example.json";
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

function shouldInstall(install) {
  return install.enabled !== false;
}

function destroyPolicy(flags) {
  return flagGet(flags, "destroy-existing") !== undefined;
}

function skipProvision(flags) {
  return flagGet(flags, "skip-provision") !== undefined;
}

function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  if (destroyPolicy(flags)) return "destroy";
  return "prompt";
}

/**
 * @param {ReturnType<typeof resolveAsteriskDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ username: string; password: string; endpointPasswords: Record<string, string> }} secrets
 * @param {{ ctPasswordCache?: { value: string | null } }} runOpts
 */
async function runConfigureOnly(deployment, flags, log, secrets, runOpts = {}) {
  errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} configure-only …\n`);
  const exec = resolveConfigureExec(deployment, proxmoxRoot);
  const configure = await configureAsteriskServer({
    exec,
    asterisk: deployment.asterisk,
    secrets,
    skipInstall: !shouldInstall(deployment.install),
    restartService: true,
  });
  const ip =
    deployment.mode === "proxmox-lxc" && isObject(deployment.proxmox)
      ? readCtPrimaryIp(
          resolvePveSshForHost(proxmoxRoot, String(deployment.proxmox.host_id)).user,
          resolvePveSshForHost(proxmoxRoot, String(deployment.proxmox.host_id)).host,
          Number(
            isObject(deployment.proxmox.lxc) ? deployment.proxmox.lxc.vmid : 0,
          ),
        )
      : null;
  return {
    ok: configure.ok !== false,
    system_id: deployment.systemId,
    mode: deployment.mode,
    configure,
    ip,
    sip_port: sipPort(deployment.asterisk),
    twilio_enabled: twilioEnabled(deployment.asterisk),
  };
}

async function deployLxc(deployment, flags, log, secrets, runOpts) {
  const { systemId, proxmox: px, install, asterisk } = deployment;
  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return { ok: false, system_id: systemId, message: "missing host_id" };

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, message: "invalid vmid" };
  }

  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );

  let skipProv = false;
  if (located) {
    const policy = existingGuestPolicy(flags);
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    }
    if (action === "skip") {
      errout.write(`[hdc] ${target} ${verb}: skipping ${systemId} (vmid ${vmid} exists).\n`);
      return {
        ok: true,
        system_id: systemId,
        skipped: true,
        message: "guest already exists",
      };
    }
    skipProv = true;
  }

  let provisionResult = null;
  if (!skipProv) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,    });
    const hostname =
      (typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
      lxcHostnameFromSystemId(systemId) ||
      "asterisk";
    const memoryMb = typeof lxc.memory_mb === "number" ? lxc.memory_mb : Number(lxc.memory_mb);
    const cores = typeof lxc.cores === "number" ? lxc.cores : Number(lxc.cores);
    const diskGb = typeof lxc.rootfs_gb === "number" ? lxc.rootfs_gb : Number(lxc.rootfs_gb);
    if (![memoryMb, cores, diskGb].every((n) => Number.isFinite(n) && n > 0)) {
      return { ok: false, system_id: systemId, message: "invalid lxc sizing" };
    }
    const cache = runOpts.ctPasswordCache ?? { value: null };
    const rootPassword = await resolveLxcRootPassword(systemId, vmid, lxc, flags, {
      cached: cache.value,
      setCached: (v) => {
        cache.value = v;
      },
    });
    provisionResult = await prov.createContainer(log, {
      name: hostname,
      memoryMb,
      cores,
      diskGb,
      parameters: { ...lxc, password: rootPassword },
    });
    if (!provisionResult.ok) {
      return { ok: false, system_id: systemId, provision: provisionResult };
    }
  } else {
    provisionResult = {
      ok: true,
      message: `LXC ${vmid} already present`,
      details: { vmid, node: located?.node, skipped_provision: true },
    };
  }

  const guestVmid = resolveProvisionVmid(provisionResult, vmid);
  await waitForLxcCreateTaskAndApplyResources(
    provisionResult,
    auth,
    vmid,
    (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    guestResourceOptsFromBlock(lxc, flags),
  );

  if (shouldInstall(install)) {
    await ensureLxcStarted({
      apiBase: auth.host.apiBase,
      node: provisionResult.details?.node || located?.node || auth.host.pveNode,
      vmid: guestVmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
  }

  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const exec = createConfigureExec("pct", {
    user: pveSsh.user,
    host: pveSsh.host,
    vmid: guestVmid,
    pveHost: pveSsh.host,
  });
  const configure = await configureAsteriskServer({
    exec,
    asterisk,
    secrets,
    skipInstall: !shouldInstall(install),
    restartService: true,
  });
  const ip = readCtPrimaryIp(pveSsh.user, pveSsh.host, guestVmid);

  return {
    ok: provisionResult.ok && configure.ok !== false,
    system_id: systemId,
    mode: "proxmox-lxc",
    host_id: hostId,
    vmid: guestVmid,
    ip,
    sip_port: sipPort(asterisk),
    twilio_enabled: twilioEnabled(asterisk),
    provision: provisionResult,
    configure,
  };
}

async function deployQemu(deployment, flags, log, secrets) {
  const { systemId, proxmox: px, install, asterisk, hostname } = deployment;
  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
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
      : "192.0.2.1";
  const guestName =
    hostname ||
    (typeof q.name === "string" && q.name.trim() ? q.name.trim() : systemId.replace(/^vm-/, ""));

  if (!Number.isFinite(vmid) || vmid <= 0 || !Number.isFinite(templateVmid) || templateVmid <= 0 || !ip) {
    return { ok: false, system_id: systemId, message: "invalid qemu vmid, template_vmid, or ip" };
  }

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await locateGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  const policy = existingGuestPolicy(flags);

  if (located) {
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    }
    if (action === "skip") {
      return { ok: true, system_id: systemId, skipped: true, message: "guest already exists" };
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
      const diskResize = await syncQemuRootfsOnMaintain({
        proxmoxPackageRoot: proxmoxRoot,
        deployment: { ...deployment.raw, system_id: systemId, mode: "proxmox-qemu", proxmox: px },
        flags,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      const exec = resolveConfigureExec(deployment, proxmoxRoot, ip);
      const configure = await configureAsteriskServer({
        exec,
        asterisk,
        secrets,
        skipInstall: !shouldInstall(install),
        restartService: true,
      });
      return {
        ok: configure.ok !== false,
        system_id: systemId,
        mode: "proxmox-qemu",
        skipped_provision: true,
        disk_resize: diskResize,
        ip: ip.split("/")[0],
        sip_port: sipPort(asterisk),
        twilio_enabled: twilioEnabled(asterisk),
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
    name: guestName,
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

  const rootfsGb = resolveRootfsGbFromDeployment({
    ...deployment.raw,
    proxmox: px,
  });
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

  const sshCfg =
    isObject(deployment.configure) && isObject(deployment.configure.ssh)
      ? deployment.configure.ssh
      : {};
  let sshUser = resolveGuestSshUser(sshCfg.user);
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];

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
    const execTmp = resolveConfigureExec(
      { ...deployment, configure: { ssh: { user: sshUser, host: sshHost } } },
      proxmoxRoot,
    );
    growRootFilesystemInGuest({ exec: execTmp, log });
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

  const exec = resolveConfigureExec(
    { ...deployment, configure: { ssh: { user: sshUser, host: sshHost } } },
    proxmoxRoot,
    ip,
  );
  const configure = await configureAsteriskServer({
    exec,
    asterisk,
    secrets,
    skipInstall: !shouldInstall(install),
    restartService: true,
  });

  return {
    ok: configure.ok !== false,
    system_id: systemId,
    mode: "proxmox-qemu",
    host_id: hostId,
    vmid: guestVmid,
    ip: sshHost,
    sip_port: sipPort(asterisk),
    twilio_enabled: twilioEnabled(asterisk),
    provision: provisionResult,
    configure,
  };
}

async function deployOne(deployment, flags, log, secrets, runOpts) {
  const inv = deployTargetInventory(root, target, { systemIdOverride: deployment.systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (skipProvision(flags) || deployment.mode === "configure-only") {
    return runConfigureOnly(deployment, flags, log, secrets, runOpts);
  }
  if (deployment.mode === "proxmox-lxc") {
    return deployLxc(deployment, flags, log, secrets, runOpts);
  }
  if (deployment.mode === "proxmox-qemu") {
    return deployQemu(deployment, flags, log, secrets);
  }
  return { ok: false, system_id: deployment.systemId, message: `unsupported mode ${deployment.mode}` };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Asterisk deploy (stderr log; JSON on stdout).\n`);

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
  let deployments;
  try {
    deployments = resolveAsteriskDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const vault = createAsteriskVaultAccess();
  await vault.unlock({});

  const log = provisionLogFromConsole(console);
  const ctPasswordCache = { value: null };
  const results = [];

  for (const deployment of deployments) {
    try {
      const secrets = await resolveAsteriskSecrets(vault, deployment.asterisk);
      results.push(await deployOne(deployment, flags, log, secrets, { ctPasswordCache }));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok !== false);
  const payload = { ok, target, verb, count: results.length, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
