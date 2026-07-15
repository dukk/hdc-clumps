export { attachQemuDataDisk } from "../../splunk/lib/proxmox-data-disk.mjs";

/** Default data mount for libraries, config, and metadata. */
export const AUDIOBOOKSHELF_DATA_MOUNT = "/data/audiobookshelf";

/** Docker images/layers on the data disk (keeps rootfs small). */
export const AUDIOBOOKSHELF_DOCKER_DATA_ROOT = "/data/audiobookshelf/docker";

/**
 * Format and mount the first unused block device; create library subdirs.
 * @param {string} mountPath e.g. /data/audiobookshelf
 */
export function buildAudiobookshelfDataDiskMountScript(mountPath) {
  const mp = mountPath.replace(/'/g, `'\\''`);
  return [
    "DISK=",
    "for d in /dev/sd? /dev/vd?; do",
    '  [ -b "$d" ] || continue',
    '  if lsblk -no MOUNTPOINT "$d" 2>/dev/null | grep -q .; then continue; fi',
    '  if mount | grep -q "^$d "; then continue; fi',
    '  DISK="$d"',
    "  break",
    "done",
    'if [ -z "$DISK" ]; then',
    '  echo "hdc-audiobookshelf: no unused data disk — ensure mount path"',
    `  mkdir -p '${mp}'`,
    `  if ! mountpoint -q '${mp}'; then`,
    `    echo "hdc-audiobookshelf: ${mp} is not mounted and no unused disk to format" >&2`,
    "    exit 1",
    "  fi",
    "else",
    '  if ! blkid "$DISK" >/dev/null 2>&1; then',
    '    mkfs.ext4 -F "$DISK"',
    "  fi",
    `  mkdir -p '${mp}'`,
    '  UUID=$(blkid -s UUID -o value "$DISK")',
    `  grep -qF "$UUID" /etc/fstab || echo "UUID=$UUID ${mp} ext4 defaults 0 2" >> /etc/fstab`,
    `  mountpoint -q '${mp}' || mount '${mp}'`,
    "fi",
    `mkdir -p '${mp}/config' '${mp}/metadata' '${mp}/audiobooks' '${mp}/podcasts' '${mp}/ebooks'`,
    "",
  ].join("\n");
}

/**
 * Ensure data subdirs exist when data disk was pre-mounted or migration pre-created paths.
 * @param {string} mountPath
 */
export function buildEnsureDataDirsScript(mountPath) {
  const mp = mountPath.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `mkdir -p '${mp}/config' '${mp}/metadata' '${mp}/audiobooks' '${mp}/podcasts' '${mp}/ebooks'`,
    "",
  ].join("\n");
}
