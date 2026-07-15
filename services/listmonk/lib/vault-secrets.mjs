import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { adminPasswordVaultKey, dbPasswordVaultKey } from "./listmonk-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./listmonk-vault-deps.mjs").createListmonkVaultAccess>} vault
 * @param {string} key
 */
async function loadOrGenerateDbPassword(vault, key) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] listmonk: DB password loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] listmonk: generated DB password and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./listmonk-vault-deps.mjs").createListmonkVaultAccess>} vault
 * @param {Record<string, unknown>} listmonk
 */
export async function resolveListmonkSecrets(vault, listmonk) {
  const cfg = isObject(listmonk) ? listmonk : {};
  const adminKey = adminPasswordVaultKey(cfg);
  const dbKey = dbPasswordVaultKey(cfg);

  await vault.unlock({});
  const adminPassword = String(
    await vault.getSecret(adminKey, { promptLabel: `vault secret ${adminKey}` }),
  ).trim();
  if (!adminPassword) {
    throw new Error(`missing vault ${adminKey}`);
  }
  errout.write(`[hdc] listmonk: admin password loaded from vault ${adminKey}\n`);

  const dbPassword = await loadOrGenerateDbPassword(vault, dbKey);

  return { adminPassword, dbPassword, adminKey, dbKey };
}
