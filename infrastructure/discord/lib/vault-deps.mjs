import { env } from "node:process";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createDiscordVaultAccess() {
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
 * Resolve bot token: repo `.env` when set, else hdc vault.
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} vaultKey
 * @param {{ required?: boolean }} [opts]
 */
export async function resolveDiscordBotToken(vault, vaultKey, opts = {}) {
  const required = opts.required !== false;
  const fromEnv = typeof env[vaultKey] === "string" ? env[vaultKey].trim() : "";
  if (fromEnv) return fromEnv;

  const fromVault = await resolveFromVault(vault, vaultKey);
  if (fromVault) return fromVault;

  if (!required) return null;

  throw new Error(
    `${vaultKey} is not set. Run: hdc secrets set ${vaultKey} — or set ${vaultKey} in repo .env`
  );
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} vaultKey
 */
export async function checkBotTokenPresent(vault, vaultKey) {
  try {
    const token = await resolveDiscordBotToken(vault, vaultKey, { required: false });
    return Boolean(token);
  } catch {
    return false;
  }
}
