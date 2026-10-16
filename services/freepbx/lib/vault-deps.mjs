import { randomBytes } from "node:crypto";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

/**
 * @param {import("hdc/cli/lib/node-cli-deps.mjs").NodeCliDeps} [deps]
 */
export function createFreepbxVaultAccess(deps) {
  return createPackageVaultAccess(deps);
}

/**
 * @param {import("hdc/package/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 * @param {string} vaultKey
 * @param {{ generate?: boolean }} [opts]
 */
export async function resolveOrCreateSecret(vaultAccess, vaultKey, opts = {}) {
  const key = String(vaultKey ?? "").trim();
  if (!key) throw new Error("vault key name is required");
  await vaultAccess.unlock({});
  const existing = String(await vaultAccess.getSecret(key, { optional: true }) ?? "").trim();
  if (existing) return existing;
  if (!opts.generate) {
    throw new Error(`vault secret ${key} is missing — run: hdc secrets set ${key}`);
  }
  const generated = randomBytes(24).toString("base64url");
  await vaultAccess.setSecret(key, generated);
  return generated;
}
