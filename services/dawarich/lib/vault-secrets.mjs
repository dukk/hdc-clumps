import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { dbPasswordVaultKey, secretKeyBaseVaultKey } from "./dawarich-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./dawarich-vault-deps.mjs").createDawarichVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 * @param {() => string} generate
 */
async function loadOrGenerateSecret(vault, key, label, generate) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] dawarich: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = generate();
  await vault.setSecret(key, generated);
  errout.write(`[hdc] dawarich: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./dawarich-vault-deps.mjs").createDawarichVaultAccess>} vault
 * @param {Record<string, unknown>} dawarich
 */
export async function resolveDawarichSecrets(vault, dawarich) {
  const cfg = isObject(dawarich) ? dawarich : {};
  const secretKey = secretKeyBaseVaultKey(cfg);
  const dbKey = dbPasswordVaultKey(cfg);

  const secretKeyBase = await loadOrGenerateSecret(
    vault,
    secretKey,
    "SECRET_KEY_BASE",
    () => randomBytes(64).toString("hex"),
  );
  const dbPassword = await loadOrGenerateSecret(
    vault,
    dbKey,
    "DB password",
    () => randomBytes(24).toString("base64url"),
  );

  return { secretKeyBase, dbPassword, secretKey, dbKey };
}
