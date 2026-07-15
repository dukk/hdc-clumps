import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

/** No package-specific vault keys; guest baseline uses shared package vault access. */
export function createNetbootXyzVaultAccess() {
  return createPackageVaultAccess();
}
