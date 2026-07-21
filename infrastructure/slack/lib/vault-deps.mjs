import { env } from "node:process";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createSlackVaultAccess() {
  return createPackageVaultAccess();
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} vaultKey
 * @param {{ required?: boolean }} [opts]
 */
export async function resolveSlackVaultSecret(vault, vaultKey, opts = {}) {
  const required = opts.required !== false;
  const key = String(vaultKey ?? "").trim();
  if (!key) {
    if (!required) return null;
    throw new Error("vault key is required");
  }
  const fromEnv = typeof env[key] === "string" ? env[key].trim() : "";
  if (fromEnv) return fromEnv;

  try {
    await vault.unlock({});
    const fromVault = String((await vault.getSecret(key, { optional: true })) ?? "").trim();
    if (fromVault) return fromVault;
  } catch {
    // Vault missing, locked, or unavailable
  }

  if (!required) return null;
  throw new Error(
    `${key} is not set. Run: hdc secrets set ${key} — or set ${key} in repo .env`,
  );
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} vaultKey
 * @param {string} value
 */
export async function writeSlackVaultSecret(vault, vaultKey, value) {
  const key = String(vaultKey ?? "").trim();
  const val = String(value ?? "").trim();
  if (!key || !val) return { ok: false, skipped: true };
  await vault.unlock({});
  await vault.setSecret(key, val);
  return { ok: true };
}
