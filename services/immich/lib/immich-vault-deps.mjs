import { env } from "node:process";

export const IMMICH_API_KEY_VAULT_KEY = "HDC_IMMICH_API_KEY";

/**
 * @param {Record<string, unknown>} immich
 */
export function apiKeyVaultKey(immich) {
  const key =
    typeof immich.api_key_vault_key === "string" && immich.api_key_vault_key.trim()
      ? immich.api_key_vault_key.trim()
      : IMMICH_API_KEY_VAULT_KEY;
  return key;
}

/**
 * @param {import("./vault-deps.mjs").createImmichVaultAccess extends Function ? ReturnType<import("./vault-deps.mjs").createImmichVaultAccess> : { unlock: Function; getSecret: Function }} vault
 * @param {Record<string, unknown>} immich
 * @param {{ required?: boolean; promptLabel?: string }} [opts]
 */
export async function resolveImmichApiKey(vault, immich, opts = {}) {
  const required = opts.required !== false;
  const vaultKey = apiKeyVaultKey(immich);
  const fromEnv = typeof env[vaultKey] === "string" ? env[vaultKey].trim() : "";
  if (fromEnv) return fromEnv;

  await vault.unlock({});
  try {
    const value = await vault.getSecret(vaultKey, {
      promptLabel: opts.promptLabel ?? `vault secret ${vaultKey}`,
      optional: true,
    });
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  } catch {
    // missing or cancelled
  }

  if (!required) return null;

  throw new Error(
    `${vaultKey} is not set. Create an Immich API key (systemConfig.read + systemConfig.update), then: node apps/hdc-cli/cli.mjs secrets set ${vaultKey}`,
  );
}
