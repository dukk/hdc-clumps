import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { dbPasswordVaultKey, secretVaultKey } from "./wallabag-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./wallabag-vault-deps.mjs").createWallabagVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 */
async function loadOrGenerateSecret(vault, key, label) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] wallabag: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] wallabag: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./wallabag-vault-deps.mjs").createWallabagVaultAccess>} vault
 * @param {Record<string, unknown>} wallabag
 */
export async function resolveWallabagSecrets(vault, wallabag) {
  const cfg = isObject(wallabag) ? wallabag : {};
  const dbKey = dbPasswordVaultKey(cfg);
  const secKey = secretVaultKey(cfg);

  await vault.unlock({});

  const dbPassword = await loadOrGenerateSecret(vault, dbKey, "DB password");
  const secret = await loadOrGenerateSecret(vault, secKey, "Symfony secret");

  return {
    dbPassword,
    secret,
    dbKey,
    secretKey: secKey,
  };
}
