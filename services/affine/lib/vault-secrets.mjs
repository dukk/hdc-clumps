import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  copilotApiKeyVaultKey,
  copilotEnabled,
  dbPasswordVaultKey,
} from "./affine-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./affine-vault-deps.mjs").createAffineVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 */
async function loadOrGenerateSecret(vault, key, label) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] affine: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(32).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] affine: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./affine-vault-deps.mjs").createAffineVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 */
async function loadRequiredSecret(vault, key, label) {
  await vault.unlock({});
  const existing =
    typeof vault.getSecret === "function"
      ? String((await vault.getSecret(key, { optional: true })) || "").trim()
      : "";
  if (!existing) {
    const data = await vault.readSecrets({});
    const fromBulk = data && typeof data[key] === "string" ? data[key].trim() : "";
    if (fromBulk) {
      errout.write(`[hdc] affine: ${label} loaded from vault ${key}\n`);
      return fromBulk;
    }
    throw new Error(
      `missing vault secret ${key} (${label}) — run: node apps/hdc-cli/cli.mjs secrets set ${key}`,
    );
  }
  errout.write(`[hdc] affine: ${label} loaded from vault ${key}\n`);
  return existing;
}

/**
 * @param {ReturnType<import("./affine-vault-deps.mjs").createAffineVaultAccess>} vault
 * @param {Record<string, unknown>} affine
 */
export async function resolveAffineSecrets(vault, affine) {
  const cfg = isObject(affine) ? affine : {};
  const dbKey = dbPasswordVaultKey(cfg);
  const dbPassword = await loadOrGenerateSecret(vault, dbKey, "DB password");

  /** @type {{ dbPassword: string; dbKey: string; copilotApiKey?: string; copilotApiKeyVaultKey?: string }} */
  const out = { dbPassword, dbKey };

  if (copilotEnabled(cfg)) {
    const apiKey = await loadRequiredSecret(
      vault,
      copilotApiKeyVaultKey(cfg),
      "Copilot / LiteLLM API key",
    );
    out.copilotApiKey = apiKey;
    out.copilotApiKeyVaultKey = copilotApiKeyVaultKey(cfg);
  }

  return out;
}
