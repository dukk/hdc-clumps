export {
  loadManualSystemSidecar,
  primaryIpFromSystem,
} from "hdc/package/inventory-sidecar.mjs";

/**
 * @param {string} systemId vm-postgres-a → a
 */
export function instanceLetterFromSystemId(systemId) {
  const m = /^vm-postgres-([a-z]+)$/.exec(systemId.trim());
  return m ? m[1] : "";
}

/**
 * @param {Record<string, unknown>} pg
 * @param {string} instanceLetter
 */
export function superuserPasswordVaultKey(pg, instanceLetter) {
  const base =
    typeof pg.superuser_vault_key === "string" && pg.superuser_vault_key.trim()
      ? pg.superuser_vault_key.trim()
      : "HDC_POSTGRESQL_SUPERUSER_PASSWORD";
  if (!instanceLetter) return base;
  const suffix = instanceLetter.toUpperCase().replace(/[^A-Z]/g, "");
  return `${base}_${suffix}`;
}

/**
 * @param {Record<string, unknown>} pg
 */
export function replicationPasswordVaultKey(pg) {
  return typeof pg.replication_vault_key === "string" && pg.replication_vault_key.trim()
    ? pg.replication_vault_key.trim()
    : "HDC_POSTGRESQL_REPLICATION_PASSWORD";
}
