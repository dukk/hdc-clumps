export { loadManualSystemSidecar, primaryIpFromSystem } from "hdc/package/inventory-sidecar.mjs";

/**
 * @param {string} systemId
 */
export function instanceLetterFromSystemId(systemId) {
  const m = /^vm-splunk-([a-z]+)$/.exec(systemId);
  return m ? m[1] : "a";
}

/**
 * @param {Record<string, unknown>} splunkBlock
 * @param {string} [letter]
 */
export function adminPasswordVaultKey(splunkBlock, letter) {
  const base =
    typeof splunkBlock.admin_vault_key === "string" && splunkBlock.admin_vault_key.trim()
      ? splunkBlock.admin_vault_key.trim()
      : "HDC_SPLUNK_ADMIN_PASSWORD";
  if (!letter || letter === "a") return base;
  return `${base}_${letter.toUpperCase()}`;
}
