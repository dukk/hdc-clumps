import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { adminPasswordVaultKey, dbPasswordVaultKey } from "./unleash-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./unleash-vault-deps.mjs").createUnleashVaultAccess>} vault
 * @param {string} key
 */
async function loadOrGenerateDbPassword(vault, key) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] unleash: DB password loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] unleash: generated DB password and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./unleash-vault-deps.mjs").createUnleashVaultAccess>} vault
 * @param {Record<string, unknown>} unleash
 */
export async function resolveUnleashSecrets(vault, unleash) {
  const cfg = isObject(unleash) ? unleash : {};
  const adminKey = adminPasswordVaultKey(cfg);
  const dbKey = dbPasswordVaultKey(cfg);

  await vault.unlock({});
  const adminPassword = String(
    await vault.getSecret(adminKey, { promptLabel: `vault secret ${adminKey}` }),
  ).trim();
  if (!adminPassword) {
    throw new Error(`missing vault ${adminKey}`);
  }
  errout.write(`[hdc] unleash: admin password loaded from vault ${adminKey}\n`);

  const dbPassword = await loadOrGenerateDbPassword(vault, dbKey);

  return { adminPassword, dbPassword, adminKey, dbKey };
}
