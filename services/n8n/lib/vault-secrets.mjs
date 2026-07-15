import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { encryptionKeyVaultKey } from "./n8n-render.mjs";

/**
 * @param {ReturnType<import("./n8n-vault-deps.mjs").createN8nVaultAccess>} vault
 * @param {string} key
 */
async function loadOrGenerateEncryptionKey(vault, key) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] n8n: encryption key loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(32).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] n8n: generated encryption key and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./n8n-vault-deps.mjs").createN8nVaultAccess>} vault
 * @param {Record<string, unknown>} n8n
 */
export async function resolveN8nEncryptionKey(vault, n8n) {
  const key = encryptionKeyVaultKey(isObject(n8n) ? n8n : {});
  const encryptionKey = await loadOrGenerateEncryptionKey(vault, key);
  return { encryptionKey, vaultKey: key };
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
