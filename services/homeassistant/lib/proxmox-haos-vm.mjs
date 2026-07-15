import { stderr as errout } from "node:process";

import {
  pveData,
  pveFormBody,
  pveJsonRequest,
  waitForPveTask,
} from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import { extractPveUpid } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { haosOvaDownloadUrl, haosOvaFilename, haosQcow2Filename } from "./haos-image.mjs";

/** Proxmox QEMU console fields for HAOS (avoid Ubuntu serial0/socket hang). */
export const HAOS_QEMU_CONSOLE_FIELDS = {
  vga: "std",
  tablet: 0,
};

/**
 * @param {Record<string, unknown>} config
 * @returns {boolean}
 */
export function haosConsoleNeedsRepair(config) {
  const vga = typeof config.vga === "string" ? config.vga.trim() : "";
  const serial0 = typeof config.serial0 === "string" ? config.serial0.trim() : "";
  return vga === "serial0" || serial0.length > 0;
}

/**
 * HAOS cannot boot when UEFI Secure Boot is enabled (pre-enrolled-keys=1 on efidisk0).
 *
 * @param {Record<string, unknown>} config
 * @returns {boolean}
 */
export function haosEfiSecureBootNeedsRepair(config) {
  const efi = typeof config.efidisk0 === "string" ? config.efidisk0 : "";
  if (!efi.trim()) return false;
  return /(?:^|,)pre-enrolled-keys=1(?:,|$)/.test(efi);
}

/**
 * @param {string} storage
 * @returns {string}
 */
export function haosEfidisk0Spec(storage) {
  return `${storage}:1,efitype=4m,pre-enrolled-keys=0,size=4M`;
}

/**
 * @param {string} user
 * @param {string} host
 * @param {string} remoteCommand
 */
function sshChecked(user, host, remoteCommand) {
  const r = sshRemote(user, host, remoteCommand, { capture: true });
  if (r.status !== 0) {
    throw new Error(
      `SSH ${user}@${host} failed (${r.status}): ${r.stderr.trim() || r.stdout.trim() || remoteCommand}`,
    );
  }
  return r.stdout;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} diskRef Proxmox disk value (volume plus optional options)
 */
function volumeRefOnly(diskRef) {
  return String(diskRef ?? "")
    .split(",")[0]
    .trim();
}

/**
 * After efidisk0 + importdisk, the HAOS image is usually on unused0 as vm-{vmid}-disk-1
 * (efidisk0 consumes disk-0). Attaching disk-0 to scsi0 causes "no bootable disk".
 *
 * @param {Record<string, unknown>} config QEMU config from GET /qemu/{vmid}/config
 * @param {string} storage Expected root disk storage id
 * @param {number} vmid
 * @returns {string} volume ref e.g. local-lvm:vm-121-disk-1
 */
export function resolveHaosImportedDiskVolume(config, storage, vmid) {
  const efiVol = volumeRefOnly(config.efidisk0);
  const scsiVol = volumeRefOnly(config.scsi0);
  const prefix = `${storage}:vm-${vmid}-disk-`;

  // scsi0 is the running HAOS root disk after boot-disk repair.
  if (scsiVol && scsiVol !== efiVol) {
    return scsiVol;
  }

  for (let i = 0; i < 8; i++) {
    const raw = config[`unused${i}`];
    if (typeof raw === "string" && raw.trim()) {
      return volumeRefOnly(raw);
    }
  }

  // Broken deploy attached scsi0 to the EFI vars disk (disk-0); HAOS import is disk-1.
  if (efiVol && scsiVol && scsiVol === efiVol) {
    return `${storage}:vm-${vmid}-disk-1`;
  }

  /** @type {{ vol: string; index: number }[]} */
  const candidates = [];
  for (const value of Object.values(config)) {
    if (typeof value !== "string") continue;
    const vol = volumeRefOnly(value);
    if (!vol.startsWith(prefix) || vol === efiVol) continue;
    const index = Number.parseInt(vol.slice(prefix.length), 10);
    if (Number.isFinite(index)) candidates.push({ vol, index });
  }

  if (!candidates.length) {
    throw new Error(
      `No imported HAOS disk found for vmid ${vmid} on ${storage} (check importdisk / unused0)`,
    );
  }

  candidates.sort((a, b) => b.index - a.index);
  return candidates[0].vol;
}

/**
 * Fix scsi0/boot when HAOS was imported after efidisk0 (disk-1) but attached as disk-0.
 *
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {number} opts.vmid
 * @param {string} opts.storage
 * @param {(line: string) => void} [opts.log]
 */
export async function repairHaosBootDisk(opts) {
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const { apiBase, node, authorization, rejectUnauthorized, vmid, storage } = opts;
  const configPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;

  const config = await fetchQemuConfig({
    apiBase,
    node,
    vmid,
    authorization,
    rejectUnauthorized,
  });
  const importedVol = resolveHaosImportedDiskVolume(config, storage, vmid);
  const currentScsi = volumeRefOnly(config.scsi0);

  if (currentScsi === importedVol) {
    log(`scsi0 already uses ${importedVol}; boot repair not needed.`);
    return { repaired: false, scsi0: currentScsi };
  }

  log(`Repairing boot disk: scsi0 ${currentScsi || "(none)"} → ${importedVol}`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      scsi0: `${importedVol},discard=on`,
      boot: "order=scsi0",
    }),
  );

  return { repaired: true, scsi0: importedVol, previous_scsi0: currentScsi || null };
}

/**
 * Remove Ubuntu-style serial console redirect (serial0 socket + vga serial0) that stalls HAOS boot.
 *
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {number} opts.vmid
 * @param {(line: string) => void} [opts.log]
 */
export async function repairHaosSerialConsole(opts) {
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const { apiBase, node, authorization, rejectUnauthorized, vmid } = opts;
  const configPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;

  const config = await fetchQemuConfig({
    apiBase,
    node,
    vmid,
    authorization,
    rejectUnauthorized,
  });

  const previousVga = typeof config.vga === "string" ? config.vga : null;
  const previousSerial0 = typeof config.serial0 === "string" ? config.serial0 : null;

  if (!haosConsoleNeedsRepair(config)) {
    log(`QEMU ${vmid}: console already uses vga=${previousVga ?? "default"} without serial0 — repair not needed.`);
    return {
      repaired: false,
      previous_vga: previousVga,
      previous_serial0: previousSerial0,
    };
  }

  log(
    `Repairing HAOS console on vmid ${vmid}: removing serial0 (was ${previousSerial0 ?? "unset"}) and vga=${previousVga ?? "default"} → vga=std …`,
  );
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      delete: "serial0",
      ...HAOS_QEMU_CONSOLE_FIELDS,
    }),
  );

  return {
    repaired: true,
    previous_vga: previousVga,
    previous_serial0: previousSerial0,
  };
}

/**
 * Recreate efidisk0 without Secure Boot when Proxmox enrolled pre-enrolled-keys=1.
 *
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {number} opts.vmid
 * @param {string} opts.storage
 * @param {(line: string) => void} [opts.log]
 */
export async function repairHaosEfiSecureBoot(opts) {
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const { apiBase, node, authorization, rejectUnauthorized, vmid, storage } = opts;
  const configPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;

  const config = await fetchQemuConfig({
    apiBase,
    node,
    vmid,
    authorization,
    rejectUnauthorized,
  });

  const previousEfi = typeof config.efidisk0 === "string" ? config.efidisk0 : null;

  if (!haosEfiSecureBootNeedsRepair(config)) {
    log(`QEMU ${vmid}: efidisk0 already has Secure Boot disabled — repair not needed.`);
    return { repaired: false, previous_efidisk0: previousEfi };
  }

  log(`Repairing HAOS EFI on vmid ${vmid}: recreating efidisk0 without pre-enrolled-keys …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({ delete: "efidisk0" }),
  );
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({ efidisk0: haosEfidisk0Spec(storage) }),
  );

  return { repaired: true, previous_efidisk0: previousEfi };
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 */
async function fetchQemuConfig(opts) {
  const configPath = `/nodes/${encodeURIComponent(opts.node)}/qemu/${encodeURIComponent(String(opts.vmid))}/config`;
  const body = await pveJsonRequest(
    "GET",
    opts.apiBase,
    configPath,
    opts.authorization,
    opts.rejectUnauthorized,
  );
  const data = pveData(body);
  if (!isObject(data)) {
    throw new Error(`Invalid qemu config for vmid ${opts.vmid}`);
  }
  return data;
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {number} opts.vmid
 * @param {string} opts.name
 * @param {number} opts.memoryMb
 * @param {number} opts.cores
 * @param {string} opts.bridge
 * @param {string} opts.storage Disk storage (local-lvm)
 * @param {string} opts.imageStorage Download/import dir storage id (local)
 * @param {string} opts.release HAOS version
 * @param {number} opts.rootfsGb Target disk size after import
 * @param {string} opts.sshUser Proxmox host SSH user
 * @param {string} opts.sshHost Proxmox host SSH address
 * @param {(line: string) => void} [opts.log]
 */
export async function provisionHaosQemuVm(opts) {
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const {
    apiBase,
    node,
    authorization,
    rejectUnauthorized,
    vmid,
    name,
    memoryMb,
    cores,
    bridge,
    storage,
    imageStorage,
    release,
    rootfsGb,
    sshUser,
    sshHost,
  } = opts;

  const xzName = haosOvaFilename(release);
  const qcow2Name = haosQcow2Filename(release);
  const downloadUrl = haosOvaDownloadUrl(release);
  const imageDir = `/var/lib/vz/template/iso`;
  const xzPath = `${imageDir}/${xzName}`;
  const qcow2Path = `${imageDir}/${qcow2Name}`;

  const createPath = `/nodes/${encodeURIComponent(node)}/qemu`;
  log(`Creating QEMU VM ${vmid} (${name}) on ${node} for Home Assistant OS …`);
  await pveJsonRequest(
    "POST",
    apiBase,
    createPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      vmid,
      name,
      memory: memoryMb,
      cores,
      ostype: "l26",
      machine: "q35",
      bios: "ovmf",
      scsihw: "virtio-scsi-pci",
      net0: `virtio,bridge=${bridge}`,
      cpu: "host",
    }),
  );

  const configPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;
  log(`Adding EFI disk for vmid ${vmid} …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      efidisk0: haosEfidisk0Spec(storage),
    }),
  );

  log(`Downloading ${xzName} on ${sshHost} (if missing) …`);
  sshChecked(
    sshUser,
    sshHost,
    `set -euo pipefail; mkdir -p ${JSON.stringify(imageDir)}; ` +
      `if [ ! -f ${JSON.stringify(qcow2Path)} ]; then ` +
      `if [ ! -f ${JSON.stringify(xzPath)} ]; then wget -q -O ${JSON.stringify(xzPath)} ${JSON.stringify(downloadUrl)}; fi; ` +
      `unxz -f ${JSON.stringify(xzPath)}; fi`,
  );

  log(`Importing ${qcow2Name} into ${storage} …`);
  const importPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/importdisk`;
  let importedViaApi = false;
  try {
    const importBody = await pveJsonRequest(
      "POST",
      apiBase,
      importPath,
      authorization,
      rejectUnauthorized,
      pveFormBody({
        storage,
        filename: qcow2Path,
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
        timeoutMs: 600_000,
        log,
      });
    }
    importedViaApi = true;
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    if (!/501|not implemented/i.test(msg)) {
      throw e;
    }
    log(`importdisk API unavailable on ${node} — using qm importdisk over SSH …`);
    sshChecked(
      sshUser,
      sshHost,
      `qm importdisk ${vmid} ${JSON.stringify(qcow2Path)} ${JSON.stringify(storage)} --format qcow2`,
    );
  }
  if (!importedViaApi) {
    log(`qm importdisk completed on ${sshHost}.`);
  }

  const configAfterImport = await fetchQemuConfig({
    apiBase,
    node,
    vmid,
    authorization,
    rejectUnauthorized,
  });
  const importedVol = resolveHaosImportedDiskVolume(configAfterImport, storage, vmid);
  log(`Attaching ${importedVol} as scsi0 and setting boot order …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({
      scsi0: `${importedVol},discard=on`,
      boot: "order=scsi0",
      ...HAOS_QEMU_CONSOLE_FIELDS,
    }),
  );

  if (rootfsGb > 0) {
    const resizePath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/resize`;
    log(`Resizing scsi0 to ${rootfsGb}G …`);
    try {
      const resizeBody = await pveJsonRequest(
        "PUT",
        apiBase,
        resizePath,
        authorization,
        rejectUnauthorized,
        pveFormBody({ disk: "scsi0", size: `${rootfsGb}G` }),
      );
      const resizeUpid = extractPveUpid(pveData(resizeBody));
      if (resizeUpid) {
        await waitForPveTask({
          apiBase,
          node,
          upid: resizeUpid,
          authorization,
          rejectUnauthorized,
          timeoutMs: 300_000,
          log,
        });
      }
    } catch (e) {
      log(`Resize skipped or failed (${/** @type {Error} */ (e).message}) — disk may already be large enough.`);
    }
  }

  return { vmid, node, name, imageStorage, storage, release };
}
