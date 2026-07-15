import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { adminPasswordVaultKey, apiTokenVaultKey, postgresVaultKey } from "./safeline-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createSafelineVaultAccess>} vault
 * @param {string} key
 */
async function loadOrGenerateSecret(vault, key) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] safeline: secret loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] safeline: generated secret and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createSafelineVaultAccess>} vault
 * @param {Record<string, unknown>} safeline
 */
export async function resolvePostgresPassword(vault, safeline) {
  const key = postgresVaultKey(isObject(safeline) ? safeline : {});
  const password = await loadOrGenerateSecret(vault, key);
  return { password, vaultKey: key };
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createSafelineVaultAccess>} vault
 * @param {Record<string, unknown>} safeline
 */
export async function resolveApiToken(vault, safeline) {
  const key = apiTokenVaultKey(isObject(safeline) ? safeline : {});
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const token = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (!token) return { token: null, vaultKey: key };
  errout.write(`[hdc] safeline: API token loaded from vault ${key}\n`);
  return { token, vaultKey: key };
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createSafelineVaultAccess>} vault
 * @param {Record<string, unknown>} safeline
 * @param {string} password
 */
export async function storeAdminPassword(vault, safeline, password) {
  const key = adminPasswordVaultKey(isObject(safeline) ? safeline : {});
  const trimmed = String(password).trim();
  if (!trimmed) {
    throw new Error(`${key} must not be empty`);
  }
  await vault.unlock({});
  await vault.setSecret(key, trimmed);
  errout.write(`[hdc] safeline: admin password stored in vault ${key}\n`);
  return { vaultKey: key };
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createSafelineVaultAccess>} vault
 * @param {Record<string, unknown>} safeline
 */
export async function adminPasswordPresent(vault, safeline) {
  const key = adminPasswordVaultKey(isObject(safeline) ? safeline : {});
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const password = data && typeof data[key] === "string" ? data[key].trim() : "";
  return { present: Boolean(password), vaultKey: key };
}
