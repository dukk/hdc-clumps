import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { dbPasswordVaultKey, secretKeyBaseVaultKey } from "./docuseal-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./docuseal-vault-deps.mjs").createDocusealVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 * @param {() => string} generate
 */
async function loadOrGenerateSecret(vault, key, label, generate) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] docuseal: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = generate();
  await vault.setSecret(key, generated);
  errout.write(`[hdc] docuseal: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./docuseal-vault-deps.mjs").createDocusealVaultAccess>} vault
 * @param {Record<string, unknown>} docuseal
 */
export async function resolveDocusealSecrets(vault, docuseal) {
  const cfg = isObject(docuseal) ? docuseal : {};
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
    () => randomBytes(32).toString("base64url"),
  );

  return { secretKeyBase, dbPassword, secretKey, dbKey };
}
