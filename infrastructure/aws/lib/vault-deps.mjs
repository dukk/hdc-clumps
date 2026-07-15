import { env } from "node:process";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

export const AWS_SECRET_ACCESS_KEY_VAULT_KEY = "HDC_AWS_SECRET_ACCESS_KEY";
export const AWS_SESSION_TOKEN_VAULT_KEY = "HDC_AWS_SESSION_TOKEN";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createAwsVaultAccess() {
  return createPackageVaultAccess();
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 */
export async function resolveAwsSecretAccessKey(vault) {
  await vault.unlock({});
  const secret = await vault.getSecret(AWS_SECRET_ACCESS_KEY_VAULT_KEY);
  if (!secret || !String(secret).trim()) {
    throw new Error(
      `${AWS_SECRET_ACCESS_KEY_VAULT_KEY} is not set. Run: hdc secrets set ${AWS_SECRET_ACCESS_KEY_VAULT_KEY}`,
    );
  }
  return String(secret).trim();
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @returns {Promise<string | undefined>}
 */
export async function resolveAwsSessionToken(vault) {
  await vault.unlock({});
  const token = await vault.getSecret(AWS_SESSION_TOKEN_VAULT_KEY);
  const t = token ? String(token).trim() : "";
  return t || undefined;
}

/**
 * @returns {string}
 */
export function resolveAwsAccessKeyId() {
  const v =
    typeof env.HDC_AWS_ACCESS_KEY_ID === "string" ? env.HDC_AWS_ACCESS_KEY_ID.trim() : "";
  if (!v) {
    throw new Error("HDC_AWS_ACCESS_KEY_ID is not set in .env");
  }
  return v;
}
