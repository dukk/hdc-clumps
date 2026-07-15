#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Deploy vLLM on Proxmox QEMU (Docker Compose; CUDA or CPU).
 *
 * Usage: hdc run service vllm deploy -- [--instance a | --system-id vm-vllm-a]
 *        hdc run service vllm deploy -- [--skip-install] [--destroy-existing]
 *        hdc run service vllm deploy -- [--skip-existing | --redeploy-existing]
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
import { guestResourceOptsFromBlock, rebootQemuGuest } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import {
  applyQemuHostpciViaSsh,
  normalizeHostpciList,
} from "../../../infrastructure/proxmox/lib/proxmox-qemu-hostpci.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { repairUbuntuQemuConsole } from "hdc/package/qemu-ubuntu-console-repair.mjs";

import { resolveVllmDeployments } from "hdc/package/deployments.mjs";
import { installVllmViaSsh, resolvePveSshForHost } from "hdc/package/vllm-install.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  migrateQemuGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  stopQemuGuest,
  waitForQemuGuestSshAfterBoot,
  waitForSsh,
} from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { createVllmVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolveVllmSecrets } from "hdc/package/vault-secrets.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/vllm/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const root = repoRoot();

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
  if (flagGet(flags, "destroy-existing", "destroy_existing") !== undefined) return "destroy";
  return "prompt";
}

function skipProvision(flags) {
  return flagGet(flags, "skip-provision", "skip_provision") !== undefined;
}

/**
 * @param {ReturnType<typeof resolveVllmDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ hfToken: string }} secrets
 */
async function deployQemuOne(deployment, flags, log, secrets) {
  const { mode, systemId, hostname, proxmox: px, configure, install, vllm } = deployment;
  const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

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

  errout.write(
    `[hdc] ${target} ${verb}: ${JSON.stringify(systemId)} proxmox-qemu on ${JSON.stringify(hostId)} …\n`,
  );
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
  /** @type {{ ok: boolean; device?: string; message?: string } | null} */
  let installResult = null;
  let cloneNode = located?.node ?? auth.host.pveNode;
  let guestVmid = vmid;
  /** @type {ReturnType<typeof normalizeHostpciList>} */
  let hostpciDeferred = [];

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
      const migrateTargetStorage =
        typeof q.migrate_target_storage === "string" && q.migrate_target_storage.trim()
          ? q.migrate_target_storage.trim()
          : undefined;
      await migrateQemuGuest({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        sourceNode: cloneNode,
        targetNode,
        vmid: guestVmid,
        targetStorage: migrateTargetStorage,
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

    // Defer hostpci until after first SSH: GPU passthrough + template serial0 console
    // can leave the guest unreachable on first boot. Bring networking up first.
    hostpciDeferred = normalizeHostpciList(q.hostpci);

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

    // Ubuntu cloud templates use serial0+vga=serial0; that stalls first boot. Prefer std VGA.
    // Also regenerate cloud-init via SSH (API POST /cloudinit is often 501) and verify ISO9660 —
    // a full thin pool yields a corrupt drive and the guest never gets a static IP.
    const consoleFix = repairUbuntuQemuConsole({
      user: pveSsh.user,
      host: pveSsh.host,
      vmid: guestVmid,
      verifyIso9660: true,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
    if (!consoleFix.ok) {
      const detail = `${consoleFix.stderr}${consoleFix.stdout}`.trim() || consoleFix.message;
      throw new Error(
        `cloud-init ISO invalid on ${cloneNode} vmid ${guestVmid}: ${detail}. ` +
          `Check thin-pool free space (pve-b local-lvm was 100% full); use storage local-lvm-data.`,
      );
    }
    errout.write(`${consoleFix.stdout || ""}\n`);

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
  }

  const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
  let sshUser = resolveGuestSshUser(sshCfg.user);
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];
  const vllmCfg = isObject(vllm) ? vllm : {};
  const guestIp = sshHost;

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
      errout.write(`[hdc] ${target} ${verb}: waiting for SSH on ${sshUser}@${sshHost} …\n`);
      try {
        await waitForSsh({ user: sshUser, host: sshHost, timeoutMs: 20_000 });
      } catch (e) {
        if (sshUser !== "root") {
          errout.write(`[hdc] ${target} ${verb}: ${sshUser} not ready — trying root@${sshHost} …\n`);
          await waitForSsh({ user: "root", host: sshHost, timeoutMs: 120_000 });
          sshUser = "root";
        } else {
          throw e;
        }
      }
      hostpciDeferred = normalizeHostpciList(q.hostpci);
    }

    if (hostpciDeferred.length) {
      const pveSshGpu = resolvePveSshForHost(proxmoxRoot, hostId);
      const already = sshRemote(
        pveSshGpu.user,
        pveSshGpu.host,
        `qm config ${guestVmid} | grep -E '^hostpci' || true`,
        { capture: true },
      );
      if (String(already.stdout || "").includes("hostpci")) {
        errout.write(
          `[hdc] ${target} ${verb}: hostpci already set on vmid ${guestVmid} — skipping re-attach.\n`,
        );
      } else {
      errout.write(
        `[hdc] ${target} ${verb}: attaching GPU hostpci on vmid ${guestVmid} after first SSH …\n`,
      );
      await stopQemuGuest({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: cloneNode,
        vmid: guestVmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      await applyQemuHostpciViaSsh({
        sshUser: pveSshGpu.user,
        sshHost: pveSshGpu.host,
        vmid: guestVmid,
        hostpci: hostpciDeferred,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      const q35 = sshRemote(pveSshGpu.user, pveSshGpu.host, `qm set ${guestVmid} -machine q35`, {
        capture: true,
      });
      if (q35.status !== 0) {
        const detail = `${q35.stderr}${q35.stdout}`.trim() || `exit ${q35.status}`;
        throw new Error(`qm set -machine q35 failed: ${detail}`);
      }
      await startQemuGuest({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: cloneNode,
        vmid: guestVmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      errout.write(`[hdc] ${target} ${verb}: waiting for SSH after GPU attach …\n`);
      const gpuSsh = await waitForQemuGuestSshAfterBoot({
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
      sshUser = gpuSsh.user;
      }
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

    let exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
    installResult = await installVllmViaSsh({
      exec,
      log,
      install,
      vllm: vllmCfg,
      hfToken: secrets.hfToken,
      guestIp,
      rebootGuest: async () => {
        await rebootQemuGuest({
          apiBase: auth.host.apiBase,
          authorization: auth.authorization,
          rejectUnauthorized: auth.rejectUnauthorized,
          node: cloneNode,
          vmid: guestVmid,
          log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
        });
        errout.write(`[hdc] ${target} ${verb}: waiting for SSH after NVIDIA reboot …\n`);
        try {
          await waitForSsh({ user: sshUser, host: sshHost, timeoutMs: 180_000 });
        } catch {
          await waitForSsh({ user: "root", host: sshHost, timeoutMs: 120_000 });
          sshUser = "root";
        }
        exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
      },
      getExec: () => exec,
    });
  } else {
    installResult = { ok: true, message: "skipped" };
    errout.write(`[hdc] ${target} ${verb}: install skipped for ${systemId}.\n`);
  }

  const ok = provisionResult?.ok !== false && (!installResult || installResult.ok);
  return {
    ok,
    system_id: systemId,
    host_id: hostId,
    mode,
    redeploy: skipProv,
    result: provisionResult,
    install: installResult,
    ssh: { user: sshUser, host: sshHost },
  };
}

async function main() {
  errout.write(
    `[hdc] ${target} ${verb}: vLLM via Proxmox QEMU + Docker (stderr log; JSON on stdout).\n`,
  );

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
  /** @type {ReturnType<typeof resolveVllmDeployments>} */
  let deployments;
  try {
    deployments = resolveVllmDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createVllmVaultAccess();
  const defaultsVllm =
    isObject(cfg.defaults) && isObject(cfg.defaults.vllm) ? cfg.defaults.vllm : {};
  let secrets;
  try {
    secrets = await resolveVllmSecrets(vault, defaultsVllm);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`,
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
      results.push(await deployQemuOne(deployment, flags, log, secrets));
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
