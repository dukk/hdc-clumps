import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  dbPasswordVaultKey,
  geoliteLicenseKeyVaultKey,
  initialApiKeyVaultKey,
} from "./shlink-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./shlink-vault-deps.mjs").createShlinkVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 */
async function loadOrGenerateSecret(vault, key, label) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] shlink: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] shlink: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./shlink-vault-deps.mjs").createShlinkVaultAccess>} vault
 * @param {Record<string, unknown>} shlink
 */
export async function resolveShlinkSecrets(vault, shlink) {
  const cfg = isObject(shlink) ? shlink : {};
  const dbKey = dbPasswordVaultKey(cfg);
  const apiKey = initialApiKeyVaultKey(cfg);
  const geoliteKey = geoliteLicenseKeyVaultKey(cfg);

  await vault.unlock({});

  const dbPassword = await loadOrGenerateSecret(vault, dbKey, "DB password");
  const initialApiKey = await loadOrGenerateSecret(vault, apiKey, "initial API key");

  const data = await vault.readSecrets({});
  const geoliteLicenseKey =
    data && typeof data[geoliteKey] === "string" ? data[geoliteKey].trim() : "";
  if (geoliteLicenseKey) {
    errout.write(`[hdc] shlink: GeoLite license loaded from vault ${geoliteKey}\n`);
  } else {
    errout.write(
      `[hdc] shlink: warning — ${geoliteKey} not set; visit geolocation will be disabled.\n`,
    );
  }

  return {
    dbPassword,
    initialApiKey,
    geoliteLicenseKey: geoliteLicenseKey || null,
    dbKey,
    apiKey,
    geoliteKey,
  };
}
