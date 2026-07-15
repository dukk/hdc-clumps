#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Deploy Ollama on Proxmox (LXC or QEMU clone) or as Docker on an Ubuntu SSH host.
 * Multi-instance: deployments[] in config.json. With no selector, deploys all entries.
 *
 * Usage: hdc run service ollama deploy -- [--instance a | --system-id ollama-a]
 *        [--skip-install] [--skip-models] [--skip-existing | --redeploy-existing] [--destroy-existing]
 *        LXC root password: prompted on create (masked), or proxmox.lxc.password / --password
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout, env } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { ensureQemuGuestAgentOnDeploy } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-install.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForLxcCreateTaskAndApplyResources } from "../../../infrastructure/proxmox/lib/proxmox-lxc-post-create.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import {
  applyQemuHostpciViaSsh,
  normalizeHostpciList,
} from "../../../infrastructure/proxmox/lib/proxmox-qemu-hostpci.mjs";
import { createUbuntuDockerHostProvisioner } from "../../../infrastructure/ubuntu/lib/ubuntu-docker-host-provisioner.mjs";
import { resolveUbuntuBootstrapSsh } from "../../../infrastructure/ubuntu/lib/ubuntu-ssh-resolve.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveOllamaDeployments } from "hdc/package/deployments.mjs";
import { createOllamaExec, syncOllamaModels } from "hdc/package/ollama-models.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { installOllamaInCt, resolvePveSshForHost } from "hdc/package/ollama-install.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { repairUbuntuQemuConsole } from "hdc/package/qemu-ubuntu-console-repair.mjs";
import { installOllamaInQemu } from "hdc/package/ollama-qemu-install.mjs";
import { resolveLxcRootPassword } from "hdc/package/lxc-password.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  migrateQemuGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  waitForQemuGuestSshAfterBoot,
  waitForSsh,
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
const CLUMP_CONFIG_EXAMPLE = "clumps/services/ollama/config.example.json";
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
const ubuntuInfraRoot = join(root, "clumps", "infrastructure", "ubuntu");

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
function destroyPolicy(flags) {
  return flagGet(flags, "destroy-existing") !== undefined;
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
 * Pull configured models after a successful deploy (never prunes on deploy).
 * @param {ReturnType<typeof resolveOllamaDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {Record<string, unknown>} deployResult
 */
async function applyDeployModelSync(deployment, flags, deployResult) {
  if (flagGet(flags, "skip-models", "skip_models") !== undefined) {
    return { ...deployResult, models: { skipped: true, message: "--skip-models" } };
  }
  const models = deployment.ollama?.models ?? [];
  if (!models.length) {
    return deployResult;
  }
  try {
    const exec = createOllamaExec(deployment, proxmoxRoot, ubuntuInfraRoot);
    errout.write(
      `[hdc] ${target} ${verb}: ${deployment.systemId} — pulling ${models.length} configured model(s) …\n`,
    );
    const sync = await syncOllamaModels(exec, models, flags, { prune: false });
    const ok = deployResult.ok !== false && sync.ok;
    return { ...deployResult, ok, models: sync };
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: model sync failed: ${msg}\n`);
    return { ...deployResult, ok: false, models: { ok: false, message: msg } };
  }
}

/**
 * @param {ReturnType<typeof resolveOllamaDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null } }} [runOpts]
 */
async function deployOne(deployment, flags, log, runOpts = {}) {
  const { mode, systemId, hostname, proxmox: px, ubuntu: ub, configure, install } = deployment;
  const ubuntuRoot = join(root, "clumps", "infrastructure", "ubuntu");

  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (!mode) {
    return { ok: false, system_id: systemId, message: "missing mode" };
  }

  if (mode === "ubuntu-docker") {
    if (!isObject(ub)) {
      return { ok: false, system_id: systemId, message: "bad ubuntu config" };
    }
    const bid = typeof ub.bootstrap_host_id === "string" ? ub.bootstrap_host_id.trim() : "";
    if (!bid) {
      return { ok: false, system_id: systemId, message: "missing bootstrap_host_id" };
    }
    errout.write(`[hdc] ${target} ${verb}: ${systemId} ubuntu-docker on ${JSON.stringify(bid)} …\n`);
    const ssh = resolveUbuntuBootstrapSsh(ubuntuRoot, bid, env);
    if (!ssh) {
      return { ok: false, system_id: systemId, message: "ssh not resolved" };
    }
    const dk = isObject(ub.docker) ? ub.docker : {};
    const prov = createUbuntuDockerHostProvisioner({ sshUser: ssh.user, sshHost: ssh.host });
    const result = await prov.createContainer(log, {
      name: typeof dk.container_name === "string" && dk.container_name.trim() ? dk.container_name.trim() : "ollama",
      parameters: { ...dk },
    });
    return { ok: result.ok, system_id: systemId, mode, result };
  }

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

  if (mode === "proxmox-lxc") {
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
    /** @type {{ ok: boolean; method?: string; message?: string } | null} */
    let installResult = null;

    if (!skipProvision) {
      const prov = createProxmoxHostProvisioner({
        apiBase: auth.host.apiBase,
        pveNode: auth.host.pveNode,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        clumpId: target,
  });
      const lxcHostname =
        (typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
        hostname ||
        systemId.replace(/[^a-zA-Z0-9.-]+/g, "-").slice(0, 63) ||
        "ollama";
      const memoryMb = typeof lxc.memory_mb === "number" ? lxc.memory_mb : Number(lxc.memory_mb);
      const cores = typeof lxc.cores === "number" ? lxc.cores : Number(lxc.cores);
      const diskGb = typeof lxc.rootfs_gb === "number" ? lxc.rootfs_gb : Number(lxc.rootfs_gb);
      if (![memoryMb, cores, diskGb].every((n) => Number.isFinite(n) && n > 0)) {
        return { ok: false, system_id: systemId, host_id: hostId, message: "invalid lxc sizing fields" };
      }
      const cache = runOpts.ctPasswordCache ?? { value: null };
      const reusePassword = cache.value !== null;
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
      if (reusePassword) {
        errout.write(`[hdc] ${target} ${verb}: using same LXC root password as prior instance in this run.\n`);
      }
      /** @type {Record<string, unknown>} */
      const parameters = { ...lxc, password: rootPassword };
      provisionResult = await prov.createContainer(log, {
        name: lxcHostname,
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
        message: `LXC ${vmid} already present on ${located.node}`,
        details: { vmid, node: located.node, type: "lxc", skipped_provision: true },
      };
    }

    await waitForLxcCreateTaskAndApplyResources(
      provisionResult,
      auth,
      vmid,
      (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      guestResourceOptsFromBlock(lxc, flags),
    );

    if (shouldInstall(install)) {
      const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
      installResult = await installOllamaInCt(pveSsh.user, pveSsh.host, vmid, install);
    } else {
      installResult = { ok: true, method: "skipped", message: "skipped" };
      errout.write(`[hdc] ${target} ${verb}: install skipped for ${systemId}.\n`);
    }

    const ok = provisionResult.ok && (!installResult || installResult.ok);
    return {
      ok,
      system_id: systemId,
      host_id: hostId,
      mode,
      redeploy: skipProvision,
      result: provisionResult,
      install: installResult,
    };
  }

  if (mode === "proxmox-qemu") {
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
    let skipProvision = false;

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
        skipProvision = true;
      }
    }

    /** @type {import("../../../lib/host-provisioner.mjs").ProvisionResult | null} */
    let provisionResult = null;
    /** @type {{ ok: boolean; method?: string; message?: string; gpu?: boolean; gpu_backend?: string | null } | null} */
    let installResult = null;
    let cloneNode = located?.node ?? auth.host.pveNode;
    let guestVmid = vmid;

    if (!skipProvision) {
      const prov = createProxmoxHostProvisioner({
        apiBase: auth.host.apiBase,
        pveNode: auth.host.pveNode,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        clumpId: target,
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
          `[hdc] ${target} ${verb}: VM ${guestVmid} on ${cloneNode} — migrating to ${targetNode} for GPU …\n`,
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

      const hostpci = normalizeHostpciList(q.hostpci);
      if (hostpci.length) {
        errout.write(`[hdc] ${target} ${verb}: applying GPU hostpci on vmid ${guestVmid} (${cloneNode}) …\n`);
        await applyQemuHostpciViaSsh({
          sshUser: pveSsh.user,
          sshHost: pveSsh.host,
          vmid: guestVmid,
          hostpci,
          log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
        });
        const q35 = sshRemote(pveSsh.user, pveSsh.host, `qm set ${guestVmid} -machine q35`, {
          capture: true,
        });
        if (q35.status !== 0) {
          const detail = `${q35.stderr}${q35.stdout}`.trim() || `exit ${q35.status}`;
          throw new Error(`qm set -machine q35 failed: ${detail}`);
        }
        errout.write(`[hdc] ${target} ${verb}: set machine type q35 on vmid ${guestVmid}.\n`);
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

      const consoleFix = repairUbuntuQemuConsole({
        user: pveSsh.user,
        host: pveSsh.host,
        vmid: guestVmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      if (!consoleFix.ok) {
        const detail = `${consoleFix.stderr}${consoleFix.stdout}`.trim() || consoleFix.message;
        throw new Error(`Ubuntu console repair failed on vmid ${guestVmid}: ${detail}`);
      }

      await startQemuGuest({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: cloneNode,
        vmid: guestVmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
    } else {
      provisionResult = {
        ok: true,
        message: `QEMU ${vmid} already present on ${located.node}`,
        details: { vmid, node: located.node, type: "qemu", skipped_provision: true },
      };
      cloneNode = located.node;
      guestVmid = vmid;
    }

    const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
    let sshUser = resolveGuestSshUser(sshCfg.user);
    const sshHost =
      typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];

    if (shouldInstall(install)) {
      if (!skipProvision) {
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
        errout.write(`[hdc] ${target} ${verb}: waiting for SSH on ${sshUser}@${sshHost} …\n`);
        await waitForSsh({ user: sshUser, host: sshHost });
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
      installResult = await installOllamaInQemu({ exec, log, install });
    } else {
      installResult = { ok: true, method: "skipped", message: "skipped" };
      errout.write(`[hdc] ${target} ${verb}: install skipped for ${systemId}.\n`);
    }

    const ok = provisionResult.ok && (!installResult || installResult.ok);
    return {
      ok,
      system_id: systemId,
      host_id: hostId,
      mode,
      redeploy: skipProvision,
      result: provisionResult,
      install: installResult,
      ssh: { user: sshUser, host: sshHost },
    };
  }

  return { ok: false, system_id: systemId, message: `unknown mode ${mode}` };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Ollama via infrastructure provisioners (stderr log; JSON on stdout).\n`);

  const cfgLoad = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  if (!cfgLoad) {
    const inv = deployTargetInventory(root, target);
    logDeployInventoryStatus(target, verb, inv);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  errout.write(`[hdc] ${target} ${verb}: config ${cfgLoad.source}\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  /** @type {ReturnType<typeof resolveOllamaDeployments>} */
  let deployments;
  try {
    deployments = resolveOllamaDeployments(cfg, flags);
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
  /** @type {{ value: string | null }} */
  const ctPasswordCache = { value: null };
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      let one = await deployOne(deployment, flags, log, { ctPasswordCache });
      if (one.ok) {
        one = await applyDeployModelSync(deployment, flags, one);
      }
      results.push(one);
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

