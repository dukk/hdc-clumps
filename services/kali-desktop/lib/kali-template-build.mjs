import { basename } from "node:path";

import { convertQemuVmToTemplate } from "../../../infrastructure/proxmox/lib/proxmox-qemu-template-build.mjs";
import {
  fetchClusterVmResources,
  locateVmidInCluster,
} from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { stopAndDestroyQemu } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { pveFormBody, pveJsonRequest } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";

/**
 * @param {string} user
 * @param {string} host
 * @param {(line: string) => void} log
 */
export async function ensureHypervisorBuildTools(user, host, log) {
  const check = sshRemote(
    user,
    host,
    `command -v virt-customize >/dev/null && command -v 7z >/dev/null && echo ok`,
    { capture: true },
  );
  if (check.status === 0 && check.stdout.includes("ok")) {
    log("Hypervisor build tools present (virt-customize, 7z).");
    return;
  }
  throw new Error(
    "pve host missing libguestfs-tools or p7zip-full — run on hypervisor: apt-get update && apt-get install -y libguestfs-tools p7zip-full",
  );
}

/**
 * @param {string} url
 */
export function archiveBasenameFromUrl(url) {
  try {
    const base = basename(new URL(url).pathname);
    return base || "kali-qemu-amd64.7z";
  } catch {
    return "kali-qemu-amd64.7z";
  }
}

/**
 * @param {string} archiveBase e.g. kali-linux-2026.1-qemu-amd64.7z
 */
export function qcow2NameFromArchive(archiveBase) {
  return archiveBase.replace(/\.7z$/i, ".qcow2");
}

/**
 * @param {string} user
 * @param {string} host
 * @param {string} remoteCommand
 * @param {(line: string) => void} log
 */
function sshChecked(user, host, remoteCommand, log) {
  log(`SSH: ${remoteCommand.slice(0, 120)}${remoteCommand.length > 120 ? "…" : ""}`);
  const r = sshRemote(user, host, remoteCommand, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(`remote command failed: ${detail}`);
  }
  return r.stdout;
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.sshUser
 * @param {string} opts.sshHost
 * @param {number} opts.templateVmid
 * @param {string} opts.templateName
 * @param {string} opts.imageUrl
 * @param {string} opts.storage Disk storage (local-lvm)
 * @param {string} opts.imageStorage ISO/image dir storage id (local)
 * @param {number} opts.memoryMb
 * @param {number} opts.cores
 * @param {string} opts.bridge
 * @param {number} [opts.rootfsGb]
 * @param {boolean} [opts.forceRebuild]
 * @param {(line: string) => void} opts.log
 */
export async function buildKaliCloudTemplate(opts) {
  const {
    apiBase,
    node,
    authorization,
    rejectUnauthorized,
    sshUser,
    sshHost,
    templateVmid,
    templateName,
    imageUrl,
    storage,
    imageStorage,
    memoryMb,
    cores,
    bridge,
    rootfsGb,
    forceRebuild = false,
    log,
  } = opts;

  await ensureHypervisorBuildTools(sshUser, sshHost, log);

  const resources = await fetchClusterVmResources(apiBase, authorization, rejectUnauthorized);
  const existing = locateVmidInCluster(resources, templateVmid);
  if (existing && !forceRebuild) {
    log(`Template vmid ${templateVmid} already exists on ${existing.node} — skipping build.`);
    return { ok: true, built: false, template_vmid: templateVmid, node: existing.node };
  }
  if (existing && forceRebuild) {
    log(`Destroying existing template vmid ${templateVmid} on ${existing.node} for rebuild …`);
    await stopAndDestroyQemu({
      apiBase,
      authorization,
      rejectUnauthorized,
      node: existing.node,
      vmid: templateVmid,
      log,
    });
  }

  const archiveName = archiveBasenameFromUrl(imageUrl);
  const qcow2Name = qcow2NameFromArchive(archiveName);
  const isoDir = `/var/lib/vz/template/iso`;
  const workDir = `${isoDir}/hdc-kali-template-build`;
  const archivePath = `${isoDir}/${archiveName}`;
  const qcow2Path = `${workDir}/${qcow2Name}`;

  sshRemote(sshUser, sshHost, `mkdir -p ${workDir}`, { capture: true });

  /** Minimum bytes for a complete Kali qemu-amd64.7z (partial wget leftovers are ~600–700 MiB). */
  const minArchiveBytes = 3_000_000_000;
  const sizeProbe = sshRemote(
    sshUser,
    sshHost,
    `test -f ${archivePath} && stat -c%s ${archivePath} || echo 0`,
    { capture: true },
  );
  const archiveBytes = Number.parseInt(String(sizeProbe.stdout).trim(), 10) || 0;
  if (archiveBytes < minArchiveBytes) {
    if (archiveBytes > 0) {
      log(`Removing incomplete archive at ${archivePath} (${archiveBytes} bytes).`);
      sshRemote(sshUser, sshHost, `rm -f ${archivePath}`, { capture: true });
    }
    log(`Downloading Kali QEMU image to ${archivePath} (wget on hypervisor; may take several minutes) …`);
    const dl = sshRemote(
      sshUser,
      sshHost,
      `wget -q -O ${archivePath} ${JSON.stringify(imageUrl)}`,
    );
    if (dl.status !== 0) {
      throw new Error(`wget download failed (exit ${dl.status})`);
    }
    const after = sshRemote(sshUser, sshHost, `stat -c%s ${archivePath}`, { capture: true });
    const bytes = Number.parseInt(String(after.stdout).trim(), 10) || 0;
    if (bytes < minArchiveBytes) {
      sshRemote(sshUser, sshHost, `rm -f ${archivePath}`, { capture: true });
      throw new Error(`download incomplete (${bytes} bytes) — retry deploy`);
    }
    log(`Download complete (${bytes} bytes).`);
  } else {
    log(`Archive already present at ${archivePath} (${archiveBytes} bytes) — skipping download.`);
  }

  log(`Extracting ${archiveName} …`);
  sshChecked(sshUser, sshHost, `7z x -y -o${workDir} ${archivePath}`, log);

  log(`Customizing image (cloud-init, qemu-guest-agent, openssh-server) …`);
  sshChecked(
    sshUser,
    sshHost,
    `virt-customize -a ${qcow2Path} --install cloud-init,qemu-guest-agent,openssh-server ` +
      `--run-command ${JSON.stringify(
        "systemctl enable ssh cloud-init-main qemu-guest-agent 2>/dev/null || systemctl enable ssh qemu-guest-agent",
      )}`,
    log,
  );

  const createPath = `/nodes/${encodeURIComponent(node)}/qemu`;
  log(`Creating VM ${templateVmid} (${templateName}) on ${node} …`);
  await pveJsonRequest(
    "POST",
    apiBase,
    createPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      vmid: templateVmid,
      name: templateName,
      memory: memoryMb,
      cores,
      scsihw: "virtio-scsi-pci",
      net0: `virtio,bridge=${bridge}`,
      agent: 1,
    }),
  );

  log(`Importing disk from ${qcow2Path} into ${storage} …`);
  sshChecked(
    sshUser,
    sshHost,
    `qm set ${templateVmid} --scsi0 ${storage}:0,import-from=${qcow2Path}`,
    log,
  );

  if (Number.isFinite(rootfsGb) && rootfsGb > 0) {
    log(`Resizing scsi0 to ${rootfsGb}G …`);
    sshChecked(sshUser, sshHost, `qm resize ${templateVmid} scsi0 ${rootfsGb}G`, log);
  }

  const configPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(templateVmid))}/config`;
  log(`Configuring cloud-init drive and boot order …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      ide2: `${storage}:cloudinit`,
      boot: "order=scsi0",
      serial0: "socket",
      vga: "serial0",
      agent: 1,
    }),
  );

  log(`Converting VM ${templateVmid} to template …`);
  await convertQemuVmToTemplate(apiBase, node, templateVmid, authorization, rejectUnauthorized);

  return { ok: true, built: true, template_vmid: templateVmid, node, qcow2_path: qcow2Path };
}
