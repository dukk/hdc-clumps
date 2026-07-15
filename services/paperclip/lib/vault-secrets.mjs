import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  anthropicApiKeyVaultKey,
  betterAuthSecretVaultKey,
  cursorApiKeyVaultKey,
  dbPasswordVaultKey,
  googleGeminiApiKeyVaultKey,
  openaiApiKeyVaultKey,
} from "./paperclip-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./paperclip-vault-deps.mjs").createPaperclipVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 */
async function loadOrGenerateSecret(vault, key, label) {
  await vault.unlock({});
  const existing = String(
    await vault.getSecret(key, { optional: true, promptLabel: `vault secret ${key}` }),
  ).trim();
  if (existing) {
    errout.write(`[hdc] paperclip: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(32).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] paperclip: generated ${label} and saved to vault ${key}\n`);
  return generated;
}

/**
 * @param {ReturnType<import("./paperclip-vault-deps.mjs").createPaperclipVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 */
async function loadOptionalSecret(vault, key, label) {
  await vault.unlock({});
  const existing = String(
    await vault.getSecret(key, { optional: true, promptLabel: `vault secret ${key}` }),
  ).trim();
  if (existing) {
    errout.write(`[hdc] paperclip: ${label} loaded from vault ${key}\n`);
  }
  return existing;
}

/**
 * @param {ReturnType<import("./paperclip-vault-deps.mjs").createPaperclipVaultAccess>} vault
 * @param {string} key
 */
async function loadSecretNoGenerate(vault, key) {
  await vault.unlock({});
  return String(
    await vault.getSecret(key, { optional: true, promptLabel: `vault secret ${key}` }),
  ).trim();
}

/**
 * @param {ReturnType<import("./paperclip-vault-deps.mjs").createPaperclipVaultAccess>} vault
 * @param {string} key
 * @param {string} guestValue
 * @param {string} label
 */
async function adoptGuestSecret(vault, key, guestValue, label) {
  const guest = String(guestValue || "").trim();
  if (!guest) {
    return "";
  }
  const vaultValue = await loadSecretNoGenerate(vault, key);
  if (vaultValue === guest) {
    errout.write(`[hdc] paperclip maintain: ${label} loaded from vault ${key}\n`);
    return guest;
  }
  if (vaultValue) {
    errout.write(
      `[hdc] paperclip maintain: warning — ${label} in vault ${key} differs from live guest; adopting guest value into vault\n`,
    );
  } else {
    errout.write(`[hdc] paperclip maintain: adopted ${label} from live guest into vault ${key}\n`);
  }
  await vault.setSecret(key, guest);
  return guest;
}

/**
 * @param {ReturnType<import("./paperclip-vault-deps.mjs").createPaperclipVaultAccess>} vault
 * @param {string} key
 * @param {string} guestValue
 * @param {string} label
 */
async function resolveMaintainSecret(vault, key, guestValue, label) {
  const guest = String(guestValue || "").trim();
  if (guest) {
    return adoptGuestSecret(vault, key, guest, label);
  }
  const vaultValue = await loadSecretNoGenerate(vault, key);
  if (vaultValue) {
    errout.write(`[hdc] paperclip maintain: ${label} loaded from vault ${key}\n`);
  }
  return vaultValue;
}

/**
 * @param {ReturnType<import("./paperclip-vault-deps.mjs").createPaperclipVaultAccess>} vault
 * @param {Record<string, unknown>} paperclip
 * @param {{ dbPassword?: string; betterAuthSecret?: string }} [guestSecrets]
 */
export async function resolvePaperclipSecretsForMaintain(vault, paperclip, guestSecrets = {}) {
  const cfg = isObject(paperclip) ? paperclip : {};
  const authKey = betterAuthSecretVaultKey(cfg);
  const dbKey = dbPasswordVaultKey(cfg);
  const cursorKey = cursorApiKeyVaultKey(cfg);
  const anthropicKey = anthropicApiKeyVaultKey(cfg);
  const openaiKey = openaiApiKeyVaultKey(cfg);
  const googleGeminiKey = googleGeminiApiKeyVaultKey(cfg);

  const betterAuthSecret = await resolveMaintainSecret(
    vault,
    authKey,
    guestSecrets.betterAuthSecret,
    "BETTER_AUTH_SECRET",
  );
  const dbPassword = await resolveMaintainSecret(vault, dbKey, guestSecrets.dbPassword, "DB password");

  if (!betterAuthSecret || !dbPassword) {
    const guestHasAny =
      String(guestSecrets.betterAuthSecret || "").trim() !== "" ||
      String(guestSecrets.dbPassword || "").trim() !== "";
    if (guestHasAny) {
      throw new Error(
        "paperclip maintain: guest .env is missing BETTER_AUTH_SECRET or POSTGRES_PASSWORD — repair /opt/paperclip/.env manually",
      );
    }
    throw new Error(
      "paperclip maintain: BETTER_AUTH_SECRET and DB password required in vault or guest .env — run deploy first or set vault keys",
    );
  }

  const cursorApiKey = await loadOptionalSecret(vault, cursorKey, "CURSOR_API_KEY");
  const anthropicApiKey = await loadOptionalSecret(vault, anthropicKey, "ANTHROPIC_API_KEY");
  const openaiApiKey = await loadOptionalSecret(vault, openaiKey, "OPENAI_API_KEY");
  const googleGeminiApiKey = await loadOptionalSecret(vault, googleGeminiKey, "GOOGLE_API_KEY");

  return {
    betterAuthSecret,
    dbPassword,
    cursorApiKey,
    anthropicApiKey,
    openaiApiKey,
    googleGeminiApiKey,
    authKey,
    dbKey,
    cursorKey,
    anthropicKey,
    openaiKey,
    googleGeminiKey,
  };
}

/**
 * @param {ReturnType<import("./paperclip-vault-deps.mjs").createPaperclipVaultAccess>} vault
 * @param {Record<string, unknown>} paperclip
 */
export async function resolvePaperclipSecrets(vault, paperclip) {
  const cfg = isObject(paperclip) ? paperclip : {};
  const authKey = betterAuthSecretVaultKey(cfg);
  const dbKey = dbPasswordVaultKey(cfg);
  const cursorKey = cursorApiKeyVaultKey(cfg);
  const anthropicKey = anthropicApiKeyVaultKey(cfg);
  const openaiKey = openaiApiKeyVaultKey(cfg);
  const googleGeminiKey = googleGeminiApiKeyVaultKey(cfg);

  const betterAuthSecret = await loadOrGenerateSecret(vault, authKey, "BETTER_AUTH_SECRET");
  const dbPassword = await loadOrGenerateSecret(vault, dbKey, "DB password");
  const cursorApiKey = await loadOptionalSecret(vault, cursorKey, "CURSOR_API_KEY");
  const anthropicApiKey = await loadOptionalSecret(vault, anthropicKey, "ANTHROPIC_API_KEY");
  const openaiApiKey = await loadOptionalSecret(vault, openaiKey, "OPENAI_API_KEY");
  const googleGeminiApiKey = await loadOptionalSecret(vault, googleGeminiKey, "GOOGLE_API_KEY");

  return {
    betterAuthSecret,
    dbPassword,
    cursorApiKey,
    anthropicApiKey,
    openaiApiKey,
    googleGeminiApiKey,
    authKey,
    dbKey,
    cursorKey,
    anthropicKey,
    openaiKey,
    googleGeminiKey,
  };
}
