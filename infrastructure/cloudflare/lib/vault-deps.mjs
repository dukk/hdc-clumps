import { env } from "node:process";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

export const CLOUDFLARE_TOKEN_VAULT_KEY = "HDC_CLOUDFLARE_API_TOKEN";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createCloudflareVaultAccess() {
  return createPackageVaultAccess();
}

/**
 * Resolve API token: repo `.env` when set, else hdc vault.
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 */
export async function resolveCloudflareToken(vault) {
  const fromEnv =
    typeof env.HDC_CLOUDFLARE_API_TOKEN === "string" ? env.HDC_CLOUDFLARE_API_TOKEN.trim() : "";
  if (fromEnv) return fromEnv;

  try {
    const secrets = await vault.readSecrets({ createIfMissing: false });
    const fromVault = secrets?.[CLOUDFLARE_TOKEN_VAULT_KEY];
    if (typeof fromVault === "string" && fromVault.trim()) {
      return fromVault.trim();
    }
  } catch {
    // Vault missing, locked, or unavailable
  }

  throw new Error(
    `${CLOUDFLARE_TOKEN_VAULT_KEY} is not set. Run: node apps/hdc-cli/cli.mjs secrets set ${CLOUDFLARE_TOKEN_VAULT_KEY} — or set it in repo .env`
  );
}
