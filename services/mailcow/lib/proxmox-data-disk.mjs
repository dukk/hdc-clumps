export { attachQemuDataDisk } from "../../splunk/lib/proxmox-data-disk.mjs";

/**
 * Format and mount the first unused block device for Mailcow stack + Docker data.
 * @param {string} mountPath e.g. /data/mailcow
 */
export function buildMailcowDataDiskMountScript(mountPath) {
  const mp = mountPath.replace(/'/g, `'\\''`);
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
    'if [ -z "$DISK" ]; then echo "hdc-mailcow: no unused data disk found — skip mount"; exit 0; fi',
    'if ! blkid "$DISK" >/dev/null 2>&1; then',
    '  mkfs.ext4 -F "$DISK"',
    "fi",
    `mkdir -p '${mp}'`,
    'UUID=$(blkid -s UUID -o value "$DISK")',
    `grep -qF "$UUID" /etc/fstab || echo "UUID=$UUID ${mp} ext4 defaults 0 2" >> /etc/fstab`,
    `mountpoint -q '${mp}' || mount '${mp}'`,
    "",
  ].join("\n");
}

/** Default mount parent when install_dir is under /data/mailcow. */
export const MAILCOW_DATA_MOUNT = "/data/mailcow";

/** Docker data-root on the data disk (keeps rootfs small). */
export const MAILCOW_DOCKER_DATA_ROOT = "/data/mailcow/docker";
