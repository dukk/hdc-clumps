import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { mongoPasswordVaultKey } from "./meshcentral-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vault
 * @param {string} key
 */
async function loadOrGenerateMongoPassword(vault, key) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] meshcentral: MongoDB password loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] meshcentral: generated MongoDB password and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vault
 * @param {Record<string, unknown>} meshcentral
 */
export async function resolveMeshcentralSecrets(vault, meshcentral) {
  const cfg = isObject(meshcentral) ? meshcentral : {};
  const mongoKey = mongoPasswordVaultKey(cfg);
  const mongoPassword = await loadOrGenerateMongoPassword(vault, mongoKey);
  return { mongoPassword, mongoKey };
}
