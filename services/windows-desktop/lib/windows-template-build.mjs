import { convertQemuVmToTemplate } from "../../../infrastructure/proxmox/lib/proxmox-qemu-template-build.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import {
  fetchClusterVmResources,
  locateVmidInCluster,
} from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { stopAndDestroyQemu } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";

import {
  autounattendIsoBasename,
  buildAndUploadAutounattendIso,
} from "./autounattend-iso.mjs";
import { resolveDiskFormat } from "./disk-format.mjs";
import { adminUsername, localeId, resolveTemplateConfig } from "./deployments.mjs";
import { verifyIsoVolidsOnNode } from "./iso-preflight.mjs";
import {
  createWindows11QemuVm,
  detachInstallIsos,
  runWindowsSysprep,
  startQemuGuest,
  waitForQemuGuestAgent,
  waitForWindowsInstallWindow,
} from "./proxmox-windows-vm.mjs";
import {
  assertNoProductKeyInUnattend,
  renderAutounattendXml,
} from "./windows-unattend.mjs";
import { ensureVirtioIsoOnNode, ensureWindowsIsoOnNode } from "./windows-iso-ensure.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("./deployments.mjs").normalizeWindowsDesktopConfig>} opts.normalized
 * @param {ReturnType<typeof import("./deployments.mjs").resolveWindowsDesktopDeployments>[number]} opts.deployment
 * @param {string} opts.adminPassword
 * @param {Record<string, string>} opts.flags
 * @param {string} opts.proxmoxRoot
 * @param {import("hdc/cli/lib/node-cli-deps.mjs").CliDeps} opts.deps
 * @param {number} opts.installTimeoutMinutes
 * @param {(line: string) => void} opts.log
 */
export async function buildWindowsTemplate(opts) {
  const { normalized, deployment, adminPassword, flags, proxmoxRoot, deps, installTimeoutMinutes, log } = opts;
  const templateCfg = resolveTemplateConfig(normalized);
  const hostId = templateCfg.hostId;
  const templateVmid = templateCfg.vmid;
  const templateName = templateCfg.name;

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const node = auth.host.pveNode;

  const forceRebuild =
    opts.flags["force-rebuild-template"] !== undefined ||
    opts.flags["destroy-existing"] !== undefined;

  const resources = await fetchClusterVmResources(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );
  const existing = locateVmidInCluster(resources, templateVmid);
  if (existing && !forceRebuild) {
    log(`Template vmid ${templateVmid} already exists on ${existing.node} — skipping build.`);
    return {
      ok: true,
      built: false,
      template_vmid: templateVmid,
      node: existing.node,
      host_id: hostId,
    };
  }
  if (existing && forceRebuild) {
    log(`Destroying existing template/builder vmid ${templateVmid} …`);
    await stopAndDestroyQemu({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: existing.node,
      vmid: templateVmid,
      log,
    });
  }

  const px = deployment.proxmox;
  const q = px.qemu;
  const net = px.network;
  const iso = px.iso;
  const isoStorage =
    (typeof q.iso_storage === "string" && q.iso_storage.trim()) ||
    (typeof iso.windows_volid === "string" ? String(iso.windows_volid).split(":")[0] : "local");

  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const sshTarget = { id: hostId, host: pveSsh.host, user: pveSsh.user, clusterId: null };
  const { identities } = discoverLocalSshMaterial();

  const refreshIso = opts.flags["refresh-iso"] !== undefined;
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
    virtioVolid: String(iso.virtio_volid ?? "local:iso/virtio-win.iso").trim(),
    spawnSync: deps.spawnSync,
    env: deps.env,
    identities,
    log,
  });

  const xml = renderAutounattendXml({
    computerName: templateCfg.builderHostname,
    adminUsername: adminUsername(deployment),
    adminPassword,
    locale: localeId(deployment),
  });
  assertNoProductKeyInUnattend(xml);

  const autounattendBasename = autounattendIsoBasename(`template-${templateVmid}`);
  const autounattendVolid = await buildAndUploadAutounattendIso({
    sshTarget,
    xml,
    isoStorage,
    basename: autounattendBasename,
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
    vmid: templateVmid,
    name: templateName,
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

  if (opts.flags["skip-install"] !== undefined) {
    log("Template VM created but not started (--skip-install).");
    return {
      ok: true,
      built: true,
      template_vmid: templateVmid,
      node,
      host_id: hostId,
      skipped_start: true,
    };
  }

  await startQemuGuest({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node,
    vmid: templateVmid,
    log,
  });

  const installMinutes = installTimeoutMinutes;
  const installWait = await waitForWindowsInstallWindow({
    apiBase: auth.host.apiBase,
    node,
    vmid: templateVmid,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    timeoutMs: installMinutes * 60_000,
    log,
  });

  if (opts.flags["skip-sysprep"] === undefined) {
    await waitForQemuGuestAgent({
      apiBase: auth.host.apiBase,
      node,
      vmid: templateVmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      timeoutMs: 30 * 60_000,
      log,
    });
    runWindowsSysprep({
      sshUser: pveSsh.user,
      sshHost: pveSsh.host,
      vmid: templateVmid,
      log,
    });
    await waitForWindowsInstallWindow({
      apiBase: auth.host.apiBase,
      node,
      vmid: templateVmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      timeoutMs: 30 * 60_000,
      log,
    });
  } else {
    log("Sysprep skipped (--skip-sysprep) — shut down and convert manually before cloning.");
  }

  await detachInstallIsos({
    apiBase: auth.host.apiBase,
    node,
    vmid: templateVmid,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    log,
  });

  log(`Converting VM ${templateVmid} to Proxmox template …`);
  await convertQemuVmToTemplate(
    auth.host.apiBase,
    node,
    templateVmid,
    auth.authorization,
    auth.rejectUnauthorized,
  );

  return {
    ok: true,
    built: true,
    template_vmid: templateVmid,
    node,
    host_id: hostId,
    install_wait: installWait,
    windows_volid: winIso.volid,
  };
}
