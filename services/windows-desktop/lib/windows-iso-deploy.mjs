import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { fetchClusterVmResources } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";
import {
  allocateNextVmid,
  locateGuest,
  stopAndDestroyQemu,
} from "../../bind/lib/proxmox-qemu-redeploy.mjs";

import {
  autounattendIsoBasename,
  buildAndUploadAutounattendIso,
} from "./autounattend-iso.mjs";
import { resolveDiskFormat } from "./disk-format.mjs";
import { adminUsername, localeId } from "./deployments.mjs";
import { verifyIsoVolidsOnNode } from "./iso-preflight.mjs";
import { ensureOemLicenseForVm } from "./oem-apply.mjs";
import { promptExistingGuestAction } from "./prompt-existing.mjs";
import {
  createWindows11QemuVm,
  startQemuGuest,
  waitForWindowsInstallWindow,
} from "./proxmox-windows-vm.mjs";
import {
  assertNoProductKeyInUnattend,
  renderAutounattendXml,
} from "./windows-unattend.mjs";
import { ensureVirtioIsoOnNode, ensureWindowsIsoOnNode } from "./windows-iso-ensure.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("./deployments.mjs").resolveWindowsDesktopDeployments>[number]} opts.deployment
 * @param {string} opts.adminPassword
 * @param {Record<string, string>} opts.flags
 * @param {string} opts.proxmoxRoot
 * @param {string} opts.repoRoot
 * @param {string} opts.target
 * @param {string} opts.verb
 * @param {number} opts.installTimeoutMinutes
 * @param {(line: string) => void} opts.log
 */
export async function deployWindowsIsoInstance(opts) {
  const {
    deployment,
    adminPassword,
    flags,
    proxmoxRoot,
    repoRoot,
    target,
    verb,
    installTimeoutMinutes,
    log,
  } = opts;

  const inv = deployTargetInventory(repoRoot, target, { systemIdOverride: deployment.systemId });
  logDeployInventoryStatus(target, verb, inv);

  const px = deployment.proxmox;
  const hostId = px.hostId;
  const q = px.qemu;
  const net = px.network;
  const iso = px.iso;
  const oem = px.oem;

  log(`${deployment.systemId} on ${hostId} (proxmox-qemu-iso) …`);

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const resources = await fetchClusterVmResources(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );

  let vmid = typeof q.vmid === "number" && Number.isFinite(q.vmid) && q.vmid > 0 ? q.vmid : null;
  if (!vmid) {
    vmid = allocateNextVmid(resources, 200);
    log(`auto-allocated vmid ${vmid}.`);
  }

  const destroyExisting = flags["destroy-existing"] !== undefined;
  const skipExisting = flags["skip-existing"] !== undefined;
  const redeployExisting = flags["redeploy-existing"] !== undefined;

  const located = await locateGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );
  if (located) {
    let action = destroyExisting ? "destroy" : skipExisting ? "skip" : redeployExisting ? "redeploy" : "prompt";
    if (action === "prompt") {
      action = await promptExistingGuestAction(
        deployment.systemId,
        vmid,
        located.node,
        located.name,
      );
    }
    if (action === "skip") {
      log(`skipping ${deployment.systemId} (vmid ${vmid} exists).`);
      return { ok: true, system_id: deployment.systemId, skipped: true, vmid };
    }
    if (action === "destroy" || destroyExisting) {
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log,
      });
    } else {
      return {
        ok: false,
        system_id: deployment.systemId,
        message: "guest exists — use --destroy-existing to rebuild",
        vmid,
      };
    }
  }

  const node = auth.host.pveNode;
  const isoStorage =
    (typeof q.iso_storage === "string" && q.iso_storage.trim()) ||
    (typeof iso.windows_volid === "string" ? String(iso.windows_volid).split(":")[0] : "local");

  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const sshTarget = { id: hostId, host: pveSsh.host, user: pveSsh.user, clusterId: null };
  const deps = createNodeCliDeps();
  const { identities } = discoverLocalSshMaterial();

  const refreshIso = flags["refresh-iso"] !== undefined;
  const winIso = await ensureWindowsIsoOnNode({
    sshTarget,
    iso,
    isoStorage,
    spawnSync: deps.spawnSync,
    env: deps.env,
    identities,
    refresh: refreshIso,
    log,
  });
  const virtioIso = await ensureVirtioIsoOnNode({
    sshTarget,
    virtioVolid: String(iso.virtio_volid ?? "").trim(),
    spawnSync: deps.spawnSync,
    env: deps.env,
    identities,
    log,
  });

  const xml = renderAutounattendXml({
    computerName: deployment.hostname,
    adminUsername: adminUsername(deployment),
    adminPassword,
    locale: localeId(deployment),
    network:
      typeof q.ip === "string" && q.ip.trim() && typeof net.gateway === "string"
        ? {
            ipCidr: q.ip.trim(),
            gateway: net.gateway.trim(),
            dnsServers: Array.isArray(net.dns) ? net.dns.map(String) : [],
          }
        : undefined,
  });
  assertNoProductKeyInUnattend(xml);

  const autounattendVolid = await buildAndUploadAutounattendIso({
    sshTarget,
    xml,
    isoStorage,
    basename: autounattendIsoBasename(deployment.systemId),
    spawnSync: deps.spawnSync,
    env: deps.env,
    identities,
    log,
  });

  await verifyIsoVolidsOnNode({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node,
    windowsVolid: winIso.volid,
    virtioVolid: virtioIso.volid,
    autounattendVolid,
  });

  const storage = typeof q.storage === "string" ? q.storage.trim() : "local-lvm";
  const diskFormat = resolveDiskFormat(q, storage);
  const memoryMb = Number(q.memory_mb) || 8192;
  const cores = Number(q.cores) || 4;
  const diskGb = Number(q.disk_gb) || 128;
  const bridge = typeof net.bridge === "string" ? net.bridge.trim() : "vmbr0";
  const machine = typeof q.machine === "string" ? q.machine.trim() : "q35";
  const cpu = typeof q.cpu === "string" ? q.cpu.trim() : "host";
  const tpmVersion = typeof q.tpm_version === "string" ? q.tpm_version.trim() : "v2.0";

  await createWindows11QemuVm({
    apiBase: auth.host.apiBase,
    node,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    vmid,
    name: deployment.hostname,
    memoryMb,
    cores,
    machine,
    storage,
    diskGb,
    bridge,
    windowsIsoVolid: winIso.volid,
    virtioIsoVolid: virtioIso.volid,
    autounattendIsoVolid: autounattendVolid,
    cpu,
    tpmVersion,
    diskFormat,
    log,
  });

  if (flags["skip-oem"] === undefined && oem.enabled !== false && oem.enabled !== 0) {
    await ensureOemLicenseForVm({
      sshTarget,
      pveNode: node,
      apiBase: auth.host.apiBase,
      node,
      vmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      spawnSync: deps.spawnSync,
      env: deps.env,
      requireFirmware: oem.require_firmware !== false && oem.require_firmware !== 0,
      log,
      warn: (line) => log(`WARN ${line}`),
    });
  } else {
    log("OEM passthrough skipped.");
  }

  /** @type {{ install_wait?: Record<string, unknown> }} */
  const extra = {};

  if (flags["skip-install"] === undefined) {
    await startQemuGuest({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node,
      vmid,
      log,
    });

    if (flags["wait-install"] !== undefined) {
      extra.install_wait = await waitForWindowsInstallWindow({
        apiBase: auth.host.apiBase,
        node,
        vmid,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        timeoutMs: installTimeoutMinutes * 60_000,
        log,
      });
    }
  } else {
    log("VM created but not started (--skip-install).");
  }

  return {
    ok: true,
    system_id: deployment.systemId,
    host_id: hostId,
    vmid,
    node,
    hostname: deployment.hostname,
    mode: "proxmox-qemu-iso",
    autounattend_volid: autounattendVolid,
    ...extra,
  };
}
