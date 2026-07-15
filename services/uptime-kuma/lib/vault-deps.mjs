import { env, stderr as errout } from "node:process";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

export const UPTIME_KUMA_USERNAME_ENV = "HDC_UPTIME_KUMA_USERNAME";
export const UPTIME_KUMA_PASSWORD_VAULT_KEY = "HDC_UPTIME_KUMA_PASSWORD";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createUptimeKumaVaultAccess() {
  return createPackageVaultAccess();
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} [usernameEnv]
 */
export async function resolveUptimeKumaUsername(usernameEnv = UPTIME_KUMA_USERNAME_ENV) {
  const fromEnv = typeof env[usernameEnv] === "string" ? env[usernameEnv].trim() : "";
  if (fromEnv) return fromEnv;
  throw new Error(
    `${usernameEnv} is not set. Add it to repo .env (admin username for Uptime Kuma web UI).`,
  );
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} [passwordVaultKey]
 */
export async function resolveUptimeKumaPassword(
  vault,
  passwordVaultKey = UPTIME_KUMA_PASSWORD_VAULT_KEY,
) {
  errout.write(`[hdc] uptime-kuma: reading vault key ${passwordVaultKey} …\n`);
  await vault.unlock({});
  const fromVault = await vault.getSecret(passwordVaultKey, { optional: true });
  if (typeof fromVault === "string" && fromVault.trim()) {
    return fromVault.trim();
  }
  throw new Error(
    `${passwordVaultKey} is not set. Run: hdc secrets set ${passwordVaultKey} ` +
      `(check active backend with: hdc env; verify with: hdc secrets get ${passwordVaultKey})`,
  );
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {{ usernameEnv?: string; passwordVaultKey?: string }} [auth]
 */
export async function resolveUptimeKumaCredentials(vault, auth = {}) {
  const usernameEnv = auth.usernameEnv ?? UPTIME_KUMA_USERNAME_ENV;
  const passwordVaultKey = auth.passwordVaultKey ?? UPTIME_KUMA_PASSWORD_VAULT_KEY;
  const username = await resolveUptimeKumaUsername(usernameEnv);
  const password = await resolveUptimeKumaPassword(vault, passwordVaultKey);
  return { username, password, usernameEnv, passwordVaultKey };
}
