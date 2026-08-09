#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Deploy Paper Minecraft on Proxmox QEMU (Ubuntu).
 *
 * Usage: hdc run service minecraft deploy -- [--instance a | --system-id vm-minecraft-a]
 *        [--destroy-existing] [--skip-provision] [--skip-install]
 *        [--skip-existing | --redeploy-existing]
 */
import { basename, dirname, join } from "node:path";
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
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { resolveMinecraftDeployments } from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";
import { installMinecraftInQemu } from "hdc/package/minecraft-install.mjs";
import { promptExistingGuestAction } from "../../ollama/lib/prompt-existing.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  migrateQemuGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  stopQemuGuest,
  waitForQemuGuestSshAfterBoot,
} from "hdc/package/proxmox-qemu-redeploy.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import {
  loadClumpConfigFromClumpRoot,
  tryLoadClumpConfigFromClumpRoot,
} from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/minecraft/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: CLUMP_CONFIG_EXAMPLE,
    });
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
 * @param {ReturnType<typeof resolveMinecraftDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
async function deployOne(deployment, flags, log) {
  const { mode, systemId, hostname, proxmox: px, configure, install, minecraft } = deployment;

  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (mode !== "proxmox-qemu") {
    return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  }

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} proxmox-qemu on ${JSON.stringify(hostId)} …\n`);
  errout.write(`[hdc] ${target} ${verb}: authorizing Proxmox API for host ${JSON.stringify(hostId)} …\n`);
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
    (typeof q.name === "string" && q.name.trim() ? q.name.trim() : systemId.replace(/^vm-/, ""));

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
      rejectUnauthorized: auth.rejectUnauthorized,
    });

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

    const targetNode = auth.host.pveNode;
    if (cloneNode !== targetNode) {
      errout.write(
        `[hdc] ${target} ${verb}: VM ${guestVmid} on ${cloneNode} — migrating to ${targetNode} …\n`,
      );
      await migrateQemuGuest({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        sourceNode: cloneNode,
        targetNode,
        vmid: guestVmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      cloneNode = targetNode;
    }

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
    const targetNode = auth.host.pveNode;
    if (cloneNode !== targetNode) {
      errout.write(
        `[hdc] ${target} ${verb}: VM ${guestVmid} on ${cloneNode} — migrating to ${targetNode} …\n`,
      );
      await stopQemuGuest({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: cloneNode,
        vmid: guestVmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      await migrateQemuGuest({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        sourceNode: cloneNode,
        targetNode,
        vmid: guestVmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      cloneNode = targetNode;
      await startQemuGuest({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: cloneNode,
        vmid: guestVmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
    }
    const rootfsGbSkip = typeof q.rootfs_gb === "number" ? q.rootfs_gb : Number(q.rootfs_gb);
    const pveSshSkip = resolvePveSshForHost(proxmoxRoot, hostId);
    if (Number.isFinite(rootfsGbSkip) && rootfsGbSkip > 0) {
      errout.write(`[hdc] ${target} ${verb}: resizing scsi0 to ${rootfsGbSkip}G on vmid ${guestVmid} …\n`);
      const resize = sshRemote(pveSshSkip.user, pveSshSkip.host, `qm resize ${guestVmid} scsi0 ${rootfsGbSkip}G`, {
        capture: true,
      });
      if (resize.status !== 0) {
        errout.write(
          `[hdc] ${target} ${verb}: qm resize warning: ${`${resize.stderr}${resize.stdout}`.trim() || `exit ${resize.status}`}\n`,
        );
      }
    }
  }

  const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
  let sshUser = resolveGuestSshUser(sshCfg.user);
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];

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

    const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
    installResult = await installMinecraftInQemu({ exec, log, install, minecraft });
  } else {
    installResult = { ok: true, message: "skipped" };
    errout.write(`[hdc] ${target} ${verb}: install skipped for ${systemId}.\n`);
  }

  const ok = provisionResult?.ok !== false && installResult?.ok !== false;
  const guestIp = sshHost || ip.split("/")[0];
  return {
    ok,
    system_id: systemId,
    host_id: hostId,
    mode,
    redeploy: skipProv,
    result: provisionResult,
    install: installResult,
    ssh: { user: sshUser, host: sshHost },
    java_port: minecraft.javaPort,
    bedrock_port: minecraft.bedrockPort,
    upstream_java: guestIp ? `${guestIp}:${minecraft.javaPort}` : null,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Paper Minecraft on Proxmox QEMU (stderr log; JSON on stdout).\n`);

  const cfgLoad = tryLoadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
  });
  if (!cfgLoad) {
    const inv = deployTargetInventory(root, target);
    logDeployInventoryStatus(target, verb, inv);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  _pkgConfig = cfgLoad;
  errout.write(`[hdc] ${target} ${verb}: config ${cfgLoad.source}\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolveMinecraftDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (deployments.length > 1) {
    errout.write(`[hdc] ${target} ${verb}: deploying ${deployments.length} instance(s) …\n`);
  }

  const log = provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await deployOne(deployment, flags, log));
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
