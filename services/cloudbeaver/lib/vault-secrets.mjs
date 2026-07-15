import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  adminEnabled,
  adminPasswordVaultKey,
} from "./cloudbeaver-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createCloudbeaverVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 * @param {number} [byteLength]
 */
async function loadOrGenerateSecret(vault, key, label, byteLength = 24) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] cloudbeaver: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(byteLength).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] cloudbeaver: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createCloudbeaverVaultAccess>} vault
 * @param {Record<string, unknown>} cloudbeaver
 */
export async function resolveCloudbeaverSecrets(vault, cloudbeaver) {
  const cfg = isObject(cloudbeaver) ? cloudbeaver : {};

  /** @type {{ adminPassword: string | null; adminKeyName: string | null }} */
  const result = {
    adminPassword: null,
    adminKeyName: null,
  };

  if (adminEnabled(cfg)) {
    const adminKeyName = adminPasswordVaultKey(cfg);
    result.adminKeyName = adminKeyName;
    result.adminPassword = await loadOrGenerateSecret(vault, adminKeyName, "admin password");
  }

  return result;
}
