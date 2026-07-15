import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  dbPasswordVaultKey,
  masterKeyVaultKey,
  normalizeBackends,
  normalizeModelList,
  openrouterApiKeyVaultKey,
  saltKeyVaultKey,
} from "./litellm-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createLitellmVaultAccess>} vault
 * @param {string} key
 * @param {() => string} generate
 * @param {string} label
 */
async function loadOrGenerate(vault, key, generate, label) {
  await vault.unlock({});
  const existingRaw = await vault.getSecret(key, { optional: true });
  const existing = typeof existingRaw === "string" ? existingRaw.trim() : "";
  if (existing) {
    errout.write(`[hdc] litellm: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = generate();
  await vault.setSecret(key, generated);
  errout.write(`[hdc] litellm: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createLitellmVaultAccess>} vault
 * @param {string} key
 */
async function loadOptionalSecret(vault, key) {
  if (!key) return null;
  await vault.unlock({});
  const existingRaw = await vault.getSecret(key, { optional: true });
  const existing = typeof existingRaw === "string" ? existingRaw.trim() : "";
  if (existing) {
    errout.write(`[hdc] litellm: optional secret loaded from vault ${key}\n`);
    return existing;
  }
  return null;
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createLitellmVaultAccess>} vault
 * @param {Record<string, unknown>} litellm
 */
export async function resolveLitellmSecrets(vault, litellm) {
  const cfg = isObject(litellm) ? litellm : {};
  const masterVaultKey = masterKeyVaultKey(cfg);
  const saltVaultKey = saltKeyVaultKey(cfg);
  const dbVaultKey = dbPasswordVaultKey(cfg);
  const openrouterVaultKey = openrouterApiKeyVaultKey(cfg);

  const masterKey = await loadOrGenerate(
    vault,
    masterVaultKey,
    () => `sk-${randomBytes(32).toString("base64url")}`,
    "master key",
  );
  if (!masterKey.startsWith("sk-")) {
    throw new Error(`${masterVaultKey} must start with sk-`);
  }

  const saltKey = await loadOrGenerate(
    vault,
    saltVaultKey,
    () => randomBytes(32).toString("base64url"),
    "salt key",
  );

  const dbPassword = await loadOrGenerate(
    vault,
    dbVaultKey,
    () => randomBytes(24).toString("base64url"),
    "database password",
  );

  const backends = normalizeBackends(cfg);
  const models = normalizeModelList(cfg.model_list, backends);
  const needsOpenrouter = models.some((m) => m.provider === "openrouter");
  let openrouterApiKey = null;
  if (needsOpenrouter) {
    openrouterApiKey = await loadOptionalSecret(vault, openrouterVaultKey);
    if (!openrouterApiKey) {
      errout.write(
        `[hdc] litellm: warning — model_list includes openrouter but vault ${openrouterVaultKey} is empty\n`,
      );
    }
  }

  return {
    masterKey,
    saltKey,
    dbPassword,
    openrouterApiKey,
    vaultKeys: {
      masterKey: masterVaultKey,
      saltKey: saltVaultKey,
      dbPassword: dbVaultKey,
      openrouterApiKey: openrouterVaultKey,
    },
  };
}
