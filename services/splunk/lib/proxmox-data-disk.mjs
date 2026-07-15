import { stderr as errout } from "node:process";

import { pveFormBody, pveJsonRequest } from "../../../infrastructure/proxmox/lib/pve-http.mjs";

/**
 * Attach a second virtio-scsi disk (scsi1) for Splunk index data.
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.storage
 * @param {number} opts.sizeGb
 * @param {(line: string) => void} [opts.log]
 */
export async function attachQemuDataDisk(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid, storage, sizeGb } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;
  const scsi1 = `${storage}:${sizeGb}`;
  log(`Attaching data disk scsi1=${scsi1} on vmid ${vmid} …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody({ scsi1 }),
  );
}

/**
 * Bash script: format and mount the first unused block device (typically /dev/sdb) for Splunk var.
 * @param {object} opts
 * @param {string} opts.mountPath
 */
export function buildDataDiskMountScript(opts) {
  const mp = opts.mountPath;
  return [
    "set -euo pipefail",
    "DISK=",
    "for d in /dev/sd? /dev/vd?; do",
    '  [ -b "$d" ] || continue',
    '  if lsblk -no MOUNTPOINT "$d" 2>/dev/null | grep -q .; then continue; fi',
    '  if mount | grep -q "^$d "; then continue; fi',
    '  DISK="$d"',
    "  break",
    "done",
    'if [ -z "$DISK" ]; then echo "hdc-splunk: no unused data disk found — skip mount"; exit 0; fi',
    'if ! blkid "$DISK" >/dev/null 2>&1; then',
    '  mkfs.ext4 -F "$DISK"',
    "fi",
    `mkdir -p ${mp}`,
    'UUID=$(blkid -s UUID -o value "$DISK")',
    `grep -qF "$UUID" /etc/fstab || echo "UUID=$UUID ${mp} ext4 defaults 0 2" >> /etc/fstab`,
    `mountpoint -q ${mp} || mount ${mp}`,
    `chown splunk:splunk ${mp} 2>/dev/null || true`,
    "",
  ].join("\n");
}
