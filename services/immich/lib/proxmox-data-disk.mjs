export { attachQemuDataDisk } from "../../splunk/lib/proxmox-data-disk.mjs";

/**
 * Format and mount the first unused block device for Immich library and Postgres data.
 * @param {string} mountPath e.g. /data/immich
 */
export function buildImmichDataDiskMountScript(mountPath) {
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
    'if [ -z "$DISK" ]; then echo "hdc-immich: no unused data disk found — skip mount"; exit 0; fi',
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
