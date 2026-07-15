#!/usr/bin/env node
/**
 * Deploy Kali Linux desktop on Proxmox QEMU from cloud-init template.
 *
 * Usage: hdc run service kali-desktop deploy -- [--instance a | --system-id vm-kali-a]
 *        [--build-template] [--destroy-existing] [--skip-provision]
 *        [--skip-existing | --redeploy-existing]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { ensureQemuGuestAgentOnDeploy } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-install.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { fetchClusterVmResources } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { waitForQemuGuestSshAfterBoot } from "hdc/package/qemu-guest-ssh-wait.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import {
  mergedProxmoxBlock,
  normalizeKaliDesktopConfig,
  resolveKaliDesktopDeployments,
} from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { buildKaliCloudTemplate } from "hdc/package/kali-template-build.mjs";
import { applyKaliCloudInit } from "hdc/package/proxmox-kali-cloud-init.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { resolvePveSshForHost } from "hdc/package/pve-ssh.mjs";
import { createKaliDesktopVaultAccess, resolveKaliPassword } from "hdc/package/vault-deps.mjs";
import {
  allocateNextVmid,
  cloneQemuGuest,
  locateGuestByName,
  startQemuGuest,
  stopAndDestroyQemu,
} from "../../bind/lib/proxmox-qemu-redeploy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/kali-desktop/config.example.json";
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function destroyPolicy(flags) {
  return flagGet(flags, "destroy-existing", "destroy_existing") !== undefined;
}

function skipProvision(flags) {
  return flagGet(flags, "skip-provision", "skip_provision") !== undefined;
}

function buildTemplate(flags) {
  return flagGet(flags, "build-template", "build_template") !== undefined;
}

function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing", "skip_existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing", "redeploy_existing") !== undefined) return "redeploy";
  if (destroyPolicy(flags)) return "destroy";
  return "prompt";
}

/**
 * @param {ReturnType<typeof resolveKaliDesktopDeployments>[number]} deployment
 * @param {Record<string, unknown>} defaults
 * @param {string} kaliPassword
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
async function deployOne(deployment, defaults, kaliPassword, flags, log) {
  const { systemId, proxmox: pxRaw, configure, kaliDesktop, hostname: cfgHostname } = deployment;

  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (skipProvision(flags)) {
    errout.write(`[hdc] ${target} ${verb}: --skip-provision set — nothing to do.\n`);
    return { ok: true, system_id: systemId, skipped: true };
  }

  const px = mergedProxmoxBlock(defaults, pxRaw);
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing proxmox.host_id" };
  }

  const q = isObject(px.qemu) ? px.qemu : {};
  const net = isObject(px.network) ? px.network : {};
  const templateVmid = typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid);
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const gateway =
    typeof net.gateway === "string" && net.gateway.trim()
      ? net.gateway.trim()
      : typeof q.gateway === "string"
        ? q.gateway.trim()
        : "192.0.2.1";
  const bridge = typeof net.bridge === "string" && net.bridge.trim() ? net.bridge.trim() : "vmbr0";
  const dnsServers = Array.isArray(net.dns)
    ? net.dns.map((d) => String(d).trim()).filter(Boolean)
    : [];
  const storage = typeof q.storage === "string" && q.storage.trim() ? q.storage.trim() : "local-lvm";
  const imageStorage =
    typeof q.image_storage === "string" && q.image_storage.trim() ? q.image_storage.trim() : "local";
  const cores = typeof q.cores === "number" ? q.cores : Number(q.cores) || 4;
  const memoryMb = typeof q.memory_mb === "number" ? q.memory_mb : Number(q.memory_mb) || 8192;
  const rootfsGb = typeof q.rootfs_gb === "number" ? q.rootfs_gb : Number(q.rootfs_gb) || 64;
  const guestName =
    cfgHostname ||
    systemId.replace(/^vm-/, "").slice(0, 63);
  const ciuser =
    typeof kaliDesktop.user === "string" && kaliDesktop.user.trim() ? kaliDesktop.user.trim() : "kali";
  const imageUrl =
    isObject(kaliDesktop.image) && typeof kaliDesktop.image.url === "string"
      ? kaliDesktop.image.url.trim()
      : "";
  const templateName =
    typeof kaliDesktop.template_name === "string" && kaliDesktop.template_name.trim()
      ? kaliDesktop.template_name.trim()
      : "kali-cloud-template";

  if (!Number.isFinite(templateVmid) || templateVmid <= 0 || !ip) {
    return { ok: false, system_id: systemId, message: "invalid template_vmid or ip" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: ${systemId} on ${hostId} — template ${templateVmid}, IP ${ip} …\n`,
  );
  errout.write(`[hdc] ${target} ${verb}: authorizing Proxmox API for ${hostId} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);

  if (buildTemplate(flags)) {
    if (!imageUrl) {
      return { ok: false, system_id: systemId, message: "kali_desktop.image.url required for --build-template" };
    }
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    const templateResult = await buildKaliCloudTemplate({
      apiBase: auth.host.apiBase,
      node: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      sshUser: pveSsh.user,
      sshHost: pveSsh.host,
      templateVmid,
      templateName,
      imageUrl,
      storage,
      imageStorage,
      memoryMb,
      cores,
      bridge,
      rootfsGb,
      forceRebuild: destroyPolicy(flags),
      log: logLine,
    });
    if (!templateResult.ok) {
      return { ok: false, system_id: systemId, template: templateResult };
    }
  }

  let resources = await fetchClusterVmResources(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );
  const locatedByName = locateGuestByName(resources, guestName);
  const policy = existingGuestPolicy(flags);

  if (locatedByName) {
    const { vmid: existingVmid, node, name } = locatedByName;
    logLine(`found existing guest ${name} (vmid ${existingVmid}) on ${node}`);
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(systemId, existingVmid, node, name);
    }
    if (action === "skip") {
      return { ok: true, system_id: systemId, skipped: true, vmid: existingVmid };
    }
    if (action === "destroy" || policy === "destroy") {
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node,
        vmid: existingVmid,
        log: logLine,
      });
      resources = await fetchClusterVmResources(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
      );
    } else {
      return {
        ok: true,
        system_id: systemId,
        skipped_provision: true,
        vmid: existingVmid,
        message: "guest exists — use --destroy-existing to rebuild",
      };
    }
  }

  let vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    vmid = allocateNextVmid(resources, 200);
  }
  logLine(`allocated vmid ${vmid} for ${guestName}`);

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
    logLine,
    guestResourceOptsFromBlock(q, flags),
  );

  if (Number.isFinite(rootfsGb) && rootfsGb > 0) {
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    logLine(`resizing scsi0 to ${rootfsGb}G on vmid ${guestVmid}`);
    const resize = sshRemote(pveSsh.user, pveSsh.host, `qm resize ${guestVmid} scsi0 ${rootfsGb}G`, {
      capture: true,
    });
    if (resize.status !== 0) {
      const detail = `${resize.stderr}${resize.stdout}`.trim() || `exit ${resize.status}`;
      logLine(`qm resize warning: ${detail}`);
    }
  }

  await applyKaliCloudInit({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: cloneNode,
    vmid: guestVmid,
    hostname: guestName,
    ipCidr: ip,
    gateway,
    ciuser,
    cipassword: kaliPassword,
    dnsServers,
    log: logLine,
  });

  await startQemuGuest({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: cloneNode,
    vmid: guestVmid,
    log: logLine,
  });

  const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
  let sshUser = resolveGuestSshUser(sshCfg.user || ciuser);
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
    log: logLine,
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
    log: logLine,
  });

  return {
    ok: true,
    system_id: systemId,
    host_id: hostId,
    vmid: guestVmid,
    ip,
    ssh_user: sshUser,
    ssh_host: sshHost,
    template_vmid: templateVmid,
    provision: provisionResult,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Kali desktop QEMU deploy (stderr log; JSON on stdout).\n`);

  const deps = createNodeCliDeps();
  const flags = parseArgvFlags(process.argv.slice(2));
  const cfg = ensurePackageConfig().data;
  const norm = normalizeKaliDesktopConfig(cfg);
  const vaultKey =
    typeof norm.kaliDesktop.password_vault_key === "string"
      ? norm.kaliDesktop.password_vault_key.trim()
      : "HDC_KALI_DESKTOP_PASSWORD";

  const vaultAccess = createKaliDesktopVaultAccess(deps);
  let kaliPassword;
  try {
    kaliPassword = await resolveKaliPassword(vaultAccess, vaultKey);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(JSON.stringify({ ok: false, target, verb, message: msg }, null, 2) + "\n");
    process.exitCode = 1;
    return;
  }

  const log = provisionLogFromConsole(console);
  const deployments = resolveKaliDesktopDeployments(cfg, flags);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let allOk = true;

  for (const d of deployments) {
    try {
      const r = await deployOne(d, norm.defaults, kaliPassword, flags, log);
      results.push(r);
      if (!r.ok) allOk = false;
    } catch (e) {
      allOk = false;
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${d.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: d.systemId, message: msg });
    }
  }

  const payload = { ok: allOk, target, verb, deployments: results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  await runOperationReportTail({
    target,
    verb,
    clumpRoot,
    payload,
    flags,
    log: (line) => errout.write(`${line}\n`),
  });
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${e.message || e}\n`);
  process.exitCode = 1;
});
