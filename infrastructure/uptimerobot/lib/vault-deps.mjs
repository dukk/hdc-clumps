import { env } from "node:process";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

export const UPTIMEROBOT_API_KEY_VAULT_KEY = "HDC_UPTIMEROBOT_API_KEY";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createUptimerobotVaultAccess() {
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
 * @param {string} [apiKeyVaultKey]
 */
export async function resolveUptimerobotApiKey(
  vault,
  apiKeyVaultKey = UPTIMEROBOT_API_KEY_VAULT_KEY
) {
  const envName = apiKeyVaultKey;
  const fromEnv = typeof env[envName] === "string" ? env[envName].trim() : "";
  if (fromEnv) return fromEnv;

  const fromVault = await resolveFromVault(vault, apiKeyVaultKey);
  if (fromVault) return fromVault;

  throw new Error(
    `${apiKeyVaultKey} is not set. Run: node apps/hdc-cli/cli.mjs secrets set ${apiKeyVaultKey} — or set ${envName} in repo .env`
  );
}
