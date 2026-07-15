import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { RUSTFS_ACCESS_KEY, RUSTFS_SECRET_KEY } from "./vault-deps.mjs";

/**
 * @param {ReturnType<import("./vault-deps.mjs").createRustfsVaultAccess>} vault
 * @param {string} key
 */
async function loadOrGenerateSecret(vault, key, byteLength = 16) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] rustfs: secret loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(byteLength).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] rustfs: generated secret and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createRustfsVaultAccess>} vault
 * @param {{ accessKeyVaultKey?: string; secretKeyVaultKey?: string }} [opts]
 */
export async function resolveRustfsCredentials(vault, opts = {}) {
  const accessKey = opts.accessKeyVaultKey || RUSTFS_ACCESS_KEY;
  const secretKey = opts.secretKeyVaultKey || RUSTFS_SECRET_KEY;
  const access = await loadOrGenerateSecret(vault, accessKey);
  const secret = await loadOrGenerateSecret(vault, secretKey);
  return { accessKey: access, secretKey: secret, accessKeyVaultKey: accessKey, secretKeyVaultKey: secretKey };
}
