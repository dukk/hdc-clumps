import { env } from "node:process";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

export const OPENROUTER_MANAGEMENT_API_KEY_VAULT_KEY = "HDC_OPENROUTER_MANAGEMENT_API_KEY";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createOpenrouterVaultAccess() {
  return createPackageVaultAccess();
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} vaultKey
 */
async function resolveFromVault(vault, vaultKey) {
  await vault.unlock({});
  try {
    const secrets = await vault.readSecrets({ createIfMissing: false });
    const fromVault = secrets?.[vaultKey];
    if (typeof fromVault === "string" && fromVault.trim()) {
      return fromVault.trim();
    }
  } catch {
    // Vault missing, locked, or unavailable
  }
  return null;
}

/**
 * Resolve API key: repo `.env` when set, else hdc vault.
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} vaultKey
 * @param {{ required?: boolean }} [opts]
 */
export async function resolveOpenrouterApiKey(vault, vaultKey, opts = {}) {
  const required = opts.required !== false;
  const envName = vaultKey;
  const fromEnv = typeof env[envName] === "string" ? env[envName].trim() : "";
  if (fromEnv) return fromEnv;

  const fromVault = await resolveFromVault(vault, vaultKey);
  if (fromVault) return fromVault;

  if (!required) return null;

  throw new Error(
    `${vaultKey} is not set. Run: hdc secrets set ${vaultKey} — or set ${envName} in repo .env`
  );
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} vaultKey
 * @param {string} value
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function writeInferenceKeyToVault(vault, vaultKey, value, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});
  if (!value?.trim()) {
    throw new Error(`${vaultKey}: inference API key value is empty`);
  }
  if (dryRun) {
    log(`dry-run: would set vault ${vaultKey}`);
    return { wrote: false, dryRun: true };
  }
  await vault.unlock({});
  await vault.setSecret(vaultKey, value.trim());
  log(`vault: set ${vaultKey}`);
  return { wrote: true, dryRun: false };
}
