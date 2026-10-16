import { basename } from "node:path";

import { convertQemuVmToTemplate } from "../../../infrastructure/proxmox/lib/proxmox-qemu-template-build.mjs";
import {
  fetchClusterVmResources,
  locateVmidInCluster,
} from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { stopAndDestroyQemu } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { pveData, pveFormBody, pveJsonRequest, waitForPveTask } from "../../../infrastructure/proxmox/lib/pve-http.mjs";

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {number} opts.templateVmid
 * @param {string} opts.templateName
 * @param {string} opts.imageUrl
 * @param {string} opts.storage
 * @param {string} [opts.imageStorage]
 * @param {number} opts.memoryMb
 * @param {number} opts.cores
 * @param {string} opts.bridge
 * @param {number} opts.rootfsGb
 * @param {boolean} [opts.forceRebuild]
 * @param {(line: string) => void} opts.log
 */
export async function ensureDebianCloudTemplate(opts) {
  const {
    apiBase,
    node,
    authorization,
    rejectUnauthorized,
    templateVmid,
    templateName,
    imageUrl,
    storage,
    imageStorage = "local",
    memoryMb,
    cores,
    bridge,
    rootfsGb,
    forceRebuild = false,
    log,
  } = opts;

  const resources = await fetchClusterVmResources(apiBase, authorization, rejectUnauthorized);
  const existing = locateVmidInCluster(resources, templateVmid);
  if (existing?.template && !forceRebuild) {
    log(`Template vmid ${templateVmid} already exists on ${existing.node} — skipping build.`);
    return { ok: true, built: false, template_vmid: templateVmid, node: existing.node };
  }
  if (existing) {
    log(`Destroying vmid ${templateVmid} on ${existing.node} before template build …`);
    await stopAndDestroyQemu({
      apiBase,
      authorization,
      rejectUnauthorized,
      node: existing.node,
      vmid: templateVmid,
      log,
    });
  }

  const imageName = basename(new URL(imageUrl).pathname) || "debian-12-genericcloud-amd64.qcow2";
  log(`Downloading Debian 12 cloud image to ${imageStorage} (${imageName}) …`);
  try {
    const dlBody = await pveJsonRequest(
      "POST",
      apiBase,
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(imageStorage)}/download-url`,
      authorization,
      rejectUnauthorized,
      pveFormBody({ url: imageUrl, content: "import", filename: imageName }),
    );
    const dlUpid = pveData(dlBody);
    if (typeof dlUpid === "string" && dlUpid.trim().startsWith("UPID:")) {
      await waitForPveTask({
        apiBase,
        node,
        upid: dlUpid.trim(),
        authorization,
        rejectUnauthorized,
        timeoutMs: 30 * 60 * 1000,
        log,
      });
    }
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    if (!/already exists|existing file|file exists/i.test(msg)) throw e;
    log(`Image ${imageName} is already on ${imageStorage}.`);
  }

  const contentBody = await pveJsonRequest(
    "GET",
    apiBase,
    `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(imageStorage)}/content`,
    authorization,
    rejectUnauthorized,
  );
  const contentRows = pveData(contentBody);
  const rows = Array.isArray(contentRows) ? contentRows : [];
  const imageRow = rows.find((row) => {
    if (!row || typeof row !== "object") return false;
    const volid = "volid" in row ? String(row.volid) : "";
    return volid.endsWith(`/${imageName}`) || volid.endsWith(imageName);
  });
  const importFrom =
    imageRow && typeof imageRow === "object" && "path" in imageRow && imageRow.path
      ? String(imageRow.path)
      : imageRow && typeof imageRow === "object" && "volid" in imageRow
        ? String(imageRow.volid)
        : "";
  if (!importFrom) {
    throw new Error(`import image ${imageName} was not found on storage ${imageStorage}`);
  }

  log(`Creating VM ${templateVmid} (${templateName}) on ${node} …`);
  await pveJsonRequest(
    "POST",
    apiBase,
    `/nodes/${encodeURIComponent(node)}/qemu`,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      vmid: templateVmid,
      name: templateName,
      memory: memoryMb,
      cores,
      scsihw: "virtio-scsi-pci",
      net0: `virtio,bridge=${bridge}`,
      ostype: "l26",
      agent: 1,
      serial0: "socket",
      vga: "serial0",
    }),
  );

  log(`Importing ${importFrom} into ${storage} …`);
  const importBody = await pveJsonRequest(
    "PUT",
    apiBase,
    `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(templateVmid))}/config`,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      scsi0: `${storage}:0,import-from=${importFrom}`,
      ide2: `${storage}:cloudinit`,
      boot: "order=scsi0",
      serial0: "socket",
      vga: "serial0",
      agent: 1,
      citype: "nocloud",
    }),
  );
  const importUpid = pveData(importBody);
  if (typeof importUpid === "string" && importUpid.trim().startsWith("UPID:")) {
    await waitForPveTask({
      apiBase,
      node,
      upid: importUpid.trim(),
      authorization,
      rejectUnauthorized,
      timeoutMs: 30 * 60 * 1000,
      log,
    });
  }

  if (Number.isFinite(rootfsGb) && rootfsGb > 0) {
    log(`Resizing scsi0 to ${rootfsGb}G …`);
    const resizeBody = await pveJsonRequest(
      "PUT",
      apiBase,
      `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(templateVmid))}/resize`,
      authorization,
      rejectUnauthorized,
      pveFormBody({ disk: "scsi0", size: `${rootfsGb}G` }),
    );
    const resizeUpid = pveData(resizeBody);
    if (typeof resizeUpid === "string" && resizeUpid.trim().startsWith("UPID:")) {
      await waitForPveTask({
        apiBase,
        node,
        upid: resizeUpid.trim(),
        authorization,
        rejectUnauthorized,
        log,
      });
    }
  }

  log(`Converting VM ${templateVmid} to template …`);
  await convertQemuVmToTemplate(apiBase, node, templateVmid, authorization, rejectUnauthorized);
  return { ok: true, built: true, template_vmid: templateVmid, node };
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.storage
 * @param {number} opts.needBytes
 * @param {(line: string) => void} opts.log
 */
export async function assertStorageFree(opts) {
  const path = `/nodes/${encodeURIComponent(opts.node)}/storage/${encodeURIComponent(opts.storage)}/status`;
  const body = await pveJsonRequest(
    "GET",
    opts.apiBase,
    path,
    opts.authorization,
    opts.rejectUnauthorized,
  );
  const data = body && typeof body === "object" && "data" in body ? body.data : body;
  const avail = data && typeof data === "object" && "avail" in data ? Number(data.avail) : NaN;
  if (!Number.isFinite(avail)) {
    opts.log(`Storage ${opts.storage} on ${opts.node}: could not read free space — continuing.`);
    return { avail: null };
  }
  const gib = (avail / 1024 ** 3).toFixed(1);
  opts.log(`Storage ${opts.storage} on ${opts.node}: ${gib} GiB free.`);
  if (avail < opts.needBytes) {
    throw new Error(
      `${opts.storage} on ${opts.node} has ${gib} GiB free; need at least ${(opts.needBytes / 1024 ** 3).toFixed(0)} GiB`,
    );
  }
  return { avail };
}
