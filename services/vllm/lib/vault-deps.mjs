import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createVllmVaultAccess() {
  return createPackageVaultAccess();
}
