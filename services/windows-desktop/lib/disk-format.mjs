/**
 * Resolve Proxmox disk format for QEMU volumes.
 * LVM-thin (local-lvm) requires raw; dir/ZFS often use qcow2.
 * @param {Record<string, unknown>} [qemuBlock]
 * @param {string} [storage]
 * @returns {"raw" | "qcow2"}
 */
export function resolveDiskFormat(qemuBlock, storage) {
  const explicit =
    qemuBlock && typeof qemuBlock.disk_format === "string"
      ? qemuBlock.disk_format.trim().toLowerCase()
      : "";
  if (explicit === "raw" || explicit === "qcow2") {
    return /** @type {"raw" | "qcow2"} */ (explicit);
  }
  const s = String(storage ?? "").trim().toLowerCase();
  if (s.includes("lvm") || s === "local-lvm") {
    return "raw";
  }
  return "qcow2";
}

/**
 * @param {string} storage
 * @param {number} diskGb
 * @param {"raw" | "qcow2"} diskFormat
 */
export function scsi0VolumeSpec(storage, diskGb, diskFormat) {
  return `${storage}:${diskGb},format=${diskFormat}`;
}
