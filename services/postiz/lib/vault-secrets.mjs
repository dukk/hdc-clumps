import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { dbPasswordVaultKey, jwtSecretVaultKey } from "./postiz-render.mjs";

/**
 * @param {ReturnType<import("./vault-deps.mjs").createPostizVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 */
async function loadOrGenerate(vault, key, label) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] postiz: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(32).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] postiz: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createPostizVaultAccess>} vault
 * @param {Record<string, unknown>} postiz
 */
export async function resolvePostizSecrets(vault, postiz) {
  const dbKey = dbPasswordVaultKey(postiz);
  const jwtKey = jwtSecretVaultKey(postiz);
  const dbPassword = await loadOrGenerate(vault, dbKey, "DB password");
  const jwtSecret = await loadOrGenerate(vault, jwtKey, "JWT secret");
  return { dbPassword, jwtSecret, dbKey, jwtKey };
}
