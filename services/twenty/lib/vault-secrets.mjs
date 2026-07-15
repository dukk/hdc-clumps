import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { dbPasswordVaultKey, encryptionKeyVaultKey, fallbackEncryptionKeyVaultKey, generateTwentyDbPassword } from "./twenty-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./twenty-vault-deps.mjs").createTwentyVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 * @param {() => string} generate
 * @param {{ allowGenerate?: boolean }} [opts]
 */
async function loadOrGenerateSecret(vault, key, label, generate, opts = {}) {
  const allowGenerate = opts.allowGenerate !== false;
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] twenty: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  if (!allowGenerate) {
    throw new Error(
      `${key} is missing from vault — restore the existing secret before maintain (never auto-generate on maintain)`,
    );
  }
  const generated = generate();
  await vault.setSecret(key, generated);
  errout.write(`[hdc] twenty: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./twenty-vault-deps.mjs").createTwentyVaultAccess>} vault
 * @param {string} key
 */
async function loadOptionalSecret(vault, key) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  return existing || null;
}

/**
 * @param {ReturnType<import("./twenty-vault-deps.mjs").createTwentyVaultAccess>} vault
 * @param {Record<string, unknown>} twenty
 * @param {{ allowGenerate?: boolean }} [opts]
 */
export async function resolveTwentySecrets(vault, twenty, opts = {}) {
  const cfg = isObject(twenty) ? twenty : {};
  const encryptionKeyName = encryptionKeyVaultKey(cfg);
  const dbKey = dbPasswordVaultKey(cfg);
  const fallbackKeyName = fallbackEncryptionKeyVaultKey(cfg);

  const encryptionKey = await loadOrGenerateSecret(
    vault,
    encryptionKeyName,
    "encryption key",
    () => randomBytes(32).toString("base64"),
    opts,
  );
  const dbPassword = await loadOrGenerateSecret(
    vault,
    dbKey,
    "DB password",
    generateTwentyDbPassword,
    opts,
  );
  const fallbackEncryptionKey = await loadOptionalSecret(vault, fallbackKeyName);

  return {
    encryptionKey,
    dbPassword,
    fallbackEncryptionKey,
    encryptionKeyName,
    dbKey,
    fallbackKeyName,
  };
}
