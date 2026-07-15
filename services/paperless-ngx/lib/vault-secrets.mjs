import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  adminBootstrapEnabled,
  adminPasswordVaultKey,
  dbPasswordVaultKey,
  secretKeyVaultKey,
} from "./paperless-ngx-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createPaperlessNgxVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 * @param {number} [byteLength]
 */
async function loadOrGenerateSecret(vault, key, label, byteLength = 32) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] paperless-ngx: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(byteLength).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] paperless-ngx: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createPaperlessNgxVaultAccess>} vault
 * @param {Record<string, unknown>} paperless
 */
export async function resolvePaperlessNgxSecrets(vault, paperless) {
  const cfg = isObject(paperless) ? paperless : {};
  const secretKeyName = secretKeyVaultKey(cfg);
  const dbKeyName = dbPasswordVaultKey(cfg);

  const secretKey = await loadOrGenerateSecret(vault, secretKeyName, "secret key", 48);
  const dbPassword = await loadOrGenerateSecret(vault, dbKeyName, "DB password");

  /** @type {{ secretKey: string; dbPassword: string; adminPassword?: string | null; secretKeyName: string; dbKeyName: string; adminKeyName?: string }} */
  const result = {
    secretKey,
    dbPassword,
    secretKeyName,
    dbKeyName,
    adminPassword: null,
  };

  if (adminBootstrapEnabled(cfg)) {
    const adminKeyName = adminPasswordVaultKey(cfg);
    result.adminKeyName = adminKeyName;
    result.adminPassword = await loadOrGenerateSecret(vault, adminKeyName, "admin password", 24);
  }

  return result;
}
