import { env } from "node:process";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

export const TWILIO_ACCOUNT_SID_VAULT_KEY = "HDC_TWILIO_ACCOUNT_SID";
export const TWILIO_AUTH_TOKEN_VAULT_KEY = "HDC_TWILIO_AUTH_TOKEN";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createTwilioVaultAccess() {
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
 * @param {string} envName
 * @param {string} vaultKey
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 */
async function resolveSecret(envName, vaultKey, vault) {
  const fromEnv = typeof env[envName] === "string" ? env[envName].trim() : "";
  if (fromEnv) return fromEnv;
  const fromVault = await resolveFromVault(vault, vaultKey);
  if (fromVault) return fromVault;
  throw new Error(
    `${vaultKey} is not set. Run: hdc secrets set ${vaultKey} — or set ${envName} in repo .env`
  );
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} [accountSidVaultKey]
 */
export async function resolveTwilioAccountSid(vault, accountSidVaultKey = TWILIO_ACCOUNT_SID_VAULT_KEY) {
  return resolveSecret(accountSidVaultKey, accountSidVaultKey, vault);
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} [authTokenVaultKey]
 */
export async function resolveTwilioAuthToken(vault, authTokenVaultKey = TWILIO_AUTH_TOKEN_VAULT_KEY) {
  return resolveSecret(authTokenVaultKey, authTokenVaultKey, vault);
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {{ accountSidVaultKey?: string; authTokenVaultKey?: string }} [keys]
 */
export async function resolveTwilioCredentials(vault, keys = {}) {
  const accountSid = await resolveTwilioAccountSid(vault, keys.accountSidVaultKey);
  const authToken = await resolveTwilioAuthToken(vault, keys.authTokenVaultKey);
  return { accountSid, authToken };
}
