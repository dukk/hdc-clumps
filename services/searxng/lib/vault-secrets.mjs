import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { secretKeyVaultKey } from "./deployments.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createSearxngVaultAccess>} vault
 * @param {string} key
 */
async function loadOrGenerateSecret(vault, key) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] searxng: secret loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(32).toString("hex");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] searxng: generated secret and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createSearxngVaultAccess>} vault
 * @param {Record<string, unknown>} searxng
 */
export async function resolveSearxngSecret(vault, searxng) {
  const key = secretKeyVaultKey(isObject(searxng) ? searxng : {});
  const secret = await loadOrGenerateSecret(vault, key);
  return { secret, vaultKey: key };
}
