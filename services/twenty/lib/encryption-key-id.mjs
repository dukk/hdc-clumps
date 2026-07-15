import { createHash } from "node:crypto";

/**
 * Twenty `enc:v2` key id — first 8 hex chars of sha256(raw key bytes).
 * @param {string} base64Key
 */
export function twentyEncryptionKeyId(base64Key) {
  const trimmed = String(base64Key || "").trim();
  const raw = Buffer.from(trimmed, "base64");
  if (raw.length === 0) {
    throw new Error("invalid ENCRYPTION_KEY (empty or not base64)");
  }
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

/**
 * @param {Record<string, unknown>} install
 */
export function hdcMetadataPath(install) {
  const dir =
    typeof install === "string"
      ? install
      : typeof install.compose_dir === "string" && install.compose_dir.trim()
        ? install.compose_dir.trim()
        : "/opt/twenty";
  return `${dir}/.hdc/encryption-key-id`;
}
