import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { dbPasswordVaultKey, jwtSecretVaultKey } from "./vikunja-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vikunja-vault-deps.mjs").createVikunjaVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 */
async function loadOrGenerateSecret(vault, key, label) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] vikunja: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(32).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] vikunja: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./vikunja-vault-deps.mjs").createVikunjaVaultAccess>} vault
 * @param {Record<string, unknown>} vikunja
 */
export async function resolveVikunjaSecrets(vault, vikunja) {
  const cfg = isObject(vikunja) ? vikunja : {};
  const jwtKey = jwtSecretVaultKey(cfg);
  const dbKey = dbPasswordVaultKey(cfg);

  const jwtSecret = await loadOrGenerateSecret(vault, jwtKey, "JWT secret");
  const dbPassword = await loadOrGenerateSecret(vault, dbKey, "DB password");

  return { jwtSecret, dbPassword, jwtKey, dbKey };
}
