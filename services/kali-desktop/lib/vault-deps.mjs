import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

/**
 * @param {import("hdc/cli/lib/node-cli-deps.mjs").NodeCliDeps} deps
 */
export function createKaliDesktopVaultAccess(deps) {
  return createPackageVaultAccess(deps);
}

/**
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 * @param {string} vaultKey
 */
export async function resolveKaliPassword(vaultAccess, vaultKey) {
  const key = String(vaultKey ?? "").trim();
  if (!key) {
    throw new Error("kali_desktop.password_vault_key is required");
  }
  const value = await vaultAccess.getSecret(key);
  if (!value || !String(value).trim()) {
    throw new Error(`vault secret ${key} is missing — run: node apps/hdc-cli/cli.mjs secrets set ${key}`);
  }
  return String(value).trim();
}
