/**
 * Home Assistant OS OVA qcow2 image URLs (GitHub releases).
 * @param {string} release e.g. "16.0"
 */
export function haosOvaFilename(release) {
  const v = String(release ?? "").trim();
  if (!v) throw new Error("homeassistant.release is required");
  return `haos_ova-${v}.qcow2.xz`;
}

/**
 * @param {string} release
 */
export function haosOvaDownloadUrl(release) {
  const v = String(release ?? "").trim();
  if (!v) throw new Error("homeassistant.release is required");
  const filename = haosOvaFilename(v);
  return `https://github.com/home-assistant/operating-system/releases/download/${encodeURIComponent(v)}/${filename}`;
}

/**
 * Decompressed qcow2 basename on the Proxmox host.
 * @param {string} release
 */
export function haosQcow2Filename(release) {
  return haosOvaFilename(release).replace(/\.xz$/i, "");
}
