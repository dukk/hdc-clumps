import { basename } from "node:path";
import {
  defaultUbuntuLtsReleaseFromConfig,
  qemuBuildSpecForUbuntuLts,
} from "./proxmox-provision-config.mjs";
import { fetchClusterVmResources, locateVmidInCluster } from "./proxmox-host-provisioner.mjs";
import { pveFormBody, pveJsonRequest, pveData, waitForPveTask } from "./pve-http.mjs";
import { ubuntuLtsByRelease } from "./ubuntu-lts-catalog.mjs";

const DEFAULT_ENTRY = ubuntuLtsByRelease("22.04");

/** Default cloud image aligned with default Ubuntu LTS (22.04). */
export const DEFAULT_QEMU_CLOUD_IMAGE = {
  url: DEFAULT_ENTRY?.cloudImageUrl ?? "",
  filename: DEFAULT_ENTRY?.cloudImageFilename ?? "ubuntu-22.04-server-cloudimg-amd64.img",
};

/**
 * @param {string} url
 */
export function cloudImageFilenameFromUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) return DEFAULT_QEMU_CLOUD_IMAGE.filename;
  try {
    const p = new URL(s).pathname;
    const base = basename(p);
    return base || DEFAULT_QEMU_CLOUD_IMAGE.filename;
  } catch {
    return DEFAULT_QEMU_CLOUD_IMAGE.filename;
  }
}

/**
 * @param {unknown} cfg
 * @returns {import("./proxmox-qemu-template-build.mjs").QemuTemplateBuildSpec | null}
 */
export function qemuTemplateBuildSpecFromConfig(cfg) {
  const release = defaultUbuntuLtsReleaseFromConfig(cfg);
  const entry = ubuntuLtsByRelease(release);
  if (!entry) return null;
  return qemuBuildSpecForUbuntuLts(cfg, entry);
}

/**
 * @typedef {object} QemuTemplateBuildSpec
 * @property {number} templateVmid
 * @property {string} templateName
 * @property {string} storage VM disk + cloud-init storage (e.g. local-lvm)
 * @property {string} imageStorage Storage for downloaded .img (e.g. local)
 * @property {string} cloudImageUrl
 * @property {string} cloudImageFilename
 * @property {number} memoryMb
 * @property {number} cores
 * @property {string} bridge
 */

/**
 * @param {string} apiBase
 * @param {string} node
 * @param {number} vmid
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function convertQemuVmToTemplate(apiBase, node, vmid, authorization, rejectUnauthorized) {
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/template`;
  await pveJsonRequest("POST", apiBase, path, authorization, rejectUnauthorized, undefined);
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {QemuTemplateBuildSpec} opts.spec
 * @param {(line: string) => void} opts.log
 */
export async function buildQemuCloudTemplate(opts) {
  const { apiBase, node, authorization, rejectUnauthorized, spec, log } = opts;
  const { templateVmid, templateName, storage, imageStorage, cloudImageUrl, cloudImageFilename } = spec;

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
      memory: spec.memoryMb,
      cores: spec.cores,
      scsihw: "virtio-scsi-pci",
      net0: `virtio,bridge=${spec.bridge}`,
    }),
  );

  const downloadPath = `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(imageStorage)}/download-url`;
  log(`Downloading cloud image to ${imageStorage} …`);
  const dlBody = await pveJsonRequest(
    "POST",
    apiBase,
    downloadPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      url: cloudImageUrl,
      content: "import",
      filename: cloudImageFilename,
    }),
  );
  const dlUpid = pveData(dlBody);
  if (typeof dlUpid === "string" && dlUpid.trim()) {
    await waitForPveTask({
      apiBase,
      node,
      upid: dlUpid.trim(),
      authorization,
      rejectUnauthorized,
      log,
    });
  }

  const importPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(templateVmid))}/importdisk`;
  log(`Importing disk into ${storage} …`);
  const importBody = await pveJsonRequest(
    "POST",
    apiBase,
    importPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      storage,
      filename: cloudImageFilename,
      format: "qcow2",
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
      log,
    });
  }
  const scsi0 = `${storage}:vm-${templateVmid}-disk-0`;

  const configPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(templateVmid))}/config`;
  log(`Configuring VM ${templateVmid} (scsi0, cloud-init, boot) …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      scsi0,
      ide2: `${storage}:cloudinit`,
      boot: "order=scsi0",
      serial0: "socket",
      vga: "serial0",
      agent: "1",
    }),
  );

  log(`Converting VM ${templateVmid} to template …`);
  await convertQemuVmToTemplate(apiBase, node, templateVmid, authorization, rejectUnauthorized);
}

/**
 * Ensure provision.qemu.template_vmid exists as a QEMU template (build or convert when missing).
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {QemuTemplateBuildSpec} opts.spec
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} [opts.warn]
 * @returns {Promise<{ ok: boolean; built: boolean; error?: string }>}
 */
export async function ensureQemuCloudTemplate(opts) {
  const { apiBase, node, authorization, rejectUnauthorized, spec, dryRun = false, log, warn = log } = opts;

  let resources;
  try {
    resources = await fetchClusterVmResources(apiBase, authorization, rejectUnauthorized);
  } catch (e) {
    const msg = /** @type {Error} */ (e).message || String(e);
    return { ok: false, built: false, error: msg };
  }

  const located = locateVmidInCluster(resources, spec.templateVmid);
  if (located?.template) {
    log(`QEMU template vmid ${spec.templateVmid} OK on ${located.node} (${located.name}).`);
    return { ok: true, built: false };
  }

  if (located && !located.template) {
    if (dryRun) {
      log(`Would convert vmid ${spec.templateVmid} on ${located.node} to a template.`);
      return { ok: true, built: false };
    }
    try {
      log(`Converting existing VM ${spec.templateVmid} on ${located.node} to template …`);
      await convertQemuVmToTemplate(
        apiBase,
        located.node,
        spec.templateVmid,
        authorization,
        rejectUnauthorized,
      );
      log(`QEMU template vmid ${spec.templateVmid} ready.`);
      return { ok: true, built: true };
    } catch (e) {
      const msg = /** @type {Error} */ (e).message || String(e);
      warn(`Failed to convert vmid ${spec.templateVmid}: ${msg}`);
      return { ok: false, built: false, error: msg };
    }
  }

  if (dryRun) {
    log(
      `Would build QEMU template vmid ${spec.templateVmid} from cloud image ${spec.cloudImageFilename} on ${node}.`,
    );
    return { ok: true, built: false };
  }

  try {
    log(
      `Building QEMU template vmid ${spec.templateVmid} from ${spec.cloudImageUrl} (this may take several minutes) …`,
    );
    await buildQemuCloudTemplate({
      apiBase,
      node,
      authorization,
      rejectUnauthorized,
      spec,
      log,
    });
    log(`QEMU template vmid ${spec.templateVmid} created on ${node}.`);
    return { ok: true, built: true };
  } catch (e) {
    const msg = /** @type {Error} */ (e).message || String(e);
    warn(`Failed to build QEMU template vmid ${spec.templateVmid}: ${msg}`);
    return { ok: false, built: false, error: msg };
  }
}
