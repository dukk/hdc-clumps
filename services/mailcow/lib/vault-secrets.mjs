import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  apiKeyVaultKey,
  dbpassVaultKey,
  dbrootVaultKey,
  redispassVaultKey,
} from "./mailcow-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createMailcowVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 */
async function loadOrGenerateSecret(vault, key, label) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] mailcow: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] mailcow: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createMailcowVaultAccess>} vault
 * @param {Record<string, unknown>} mailcow
 */
export async function resolveMailcowDbSecrets(vault, mailcow) {
  const mc = isObject(mailcow) ? mailcow : {};
  const dbpassKey = dbpassVaultKey(mc);
  const dbrootKey = dbrootVaultKey(mc);
  const redisKey = redispassVaultKey(mc);
  const [dbpass, dbroot, redispass] = await Promise.all([
    loadOrGenerateSecret(vault, dbpassKey, "DB password"),
    loadOrGenerateSecret(vault, dbrootKey, "DB root password"),
    loadOrGenerateSecret(vault, redisKey, "Redis password"),
  ]);
  return { dbpass, dbroot, redispass };
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createMailcowVaultAccess>} vault
 * @param {Record<string, unknown>} mailcow
 * @param {{ required?: boolean }} [opts]
 */
export async function resolveMailcowApiKey(vault, mailcow, opts = {}) {
  const mc = isObject(mailcow) ? mailcow : {};
  const vaultKey = apiKeyVaultKey(mc);
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[vaultKey] === "string" ? data[vaultKey].trim() : "";
  if (existing) {
    errout.write(`[hdc] mailcow: API key loaded from vault ${vaultKey}\n`);
    return existing;
  }
  if (opts.required) {
    throw new Error(`missing vault ${vaultKey} — create API key in Mailcow admin UI`);
  }
  errout.write(`[hdc] mailcow: vault ${vaultKey} not set — skipping API reconciliation\n`);
  return null;
}
