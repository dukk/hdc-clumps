import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { resolvePrimaryOllamaBackend } from "./hermes-config-render.mjs";
import {
  dashboardAuthSecretVaultKey,
  dashboardPasswordVaultKey,
  openrouterFallbackVaultKey,
  openrouterVaultKey,
} from "./deployments.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createHermesVaultAccess>} vault
 * @param {string} key
 * @param {{ generate?: boolean; label?: string }} [opts]
 */
async function loadSecret(vault, key, opts = {}) {
  await vault.unlock({});
  const existing = String(await vault.getSecret(key, { optional: true, promptLabel: opts.label })).trim();
  if (existing) {
    errout.write(`[hdc] hermes: secret loaded ${key}\n`);
    return existing;
  }
  if (opts.generate) {
    const generated = randomBytes(32).toString("hex");
    await vault.setSecret(key, generated);
    errout.write(`[hdc] hermes: generated secret and saved to vault ${key}\n`);
    return generated;
  }
  throw new Error(
    `missing vault secret ${key}${opts.label ? ` (${opts.label})` : ""} — run: node apps/hdc-cli/cli.mjs secrets set ${key}`,
  );
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createHermesVaultAccess>} vault
 * @param {Record<string, unknown>} hermes
 */
async function loadOpenrouterApiKey(vault, hermes) {
  const cfg = isObject(hermes) ? hermes : {};
  const primaryKey = openrouterVaultKey(cfg);
  const fallbackKey = openrouterFallbackVaultKey();
  const keys = primaryKey === fallbackKey ? [primaryKey] : [primaryKey, fallbackKey];

  await vault.unlock({});

  for (const key of keys) {
    const existing = String(await vault.getSecret(key, { optional: true })).trim();
    if (existing) {
      errout.write(`[hdc] hermes: OpenRouter secret loaded ${key}\n`);
      return { value: existing, vaultKey: key };
    }
  }

  throw new Error(
    `missing OpenRouter API key — run: node apps/hdc-cli/cli.mjs secrets set ${primaryKey}` +
      (primaryKey !== fallbackKey ? ` (or ${fallbackKey})` : ""),
  );
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createHermesVaultAccess>} vault
 * @param {Record<string, unknown>} hermes
 */
export async function resolveHermesSecrets(vault, hermes) {
  const cfg = isObject(hermes) ? hermes : {};
  const dashboardPasswordKey = dashboardPasswordVaultKey(cfg);
  const dashboardAuthSecretKey = dashboardAuthSecretVaultKey(cfg);

  const openrouter = await loadOpenrouterApiKey(vault, cfg);
  const openrouterApiKey = openrouter.value;
  const dashboardPassword = await loadSecret(vault, dashboardPasswordKey, {
    label: "dashboard basic auth password",
    generate: true,
  });
  const dashboardAuthSecret = await loadSecret(vault, dashboardAuthSecretKey, {
    generate: true,
  });

  /** @type {Record<string, string>} */
  const extraEnv = {};
  const envExtra = isObject(cfg.env_extra) ? cfg.env_extra : {};
  for (const [envName, vaultKeyRaw] of Object.entries(envExtra)) {
    const envVar = typeof envName === "string" ? envName.trim() : "";
    const vaultKey = typeof vaultKeyRaw === "string" ? vaultKeyRaw.trim() : "";
    if (!envVar || !vaultKey) continue;
    extraEnv[envVar] = await loadSecret(vault, vaultKey, { label: envVar });
  }

  const discord = isObject(cfg.discord) ? cfg.discord : {};
  if (discord.enabled !== false) {
    const discordVaultKey =
      typeof discord.bot_token_vault_key === "string" && discord.bot_token_vault_key.trim()
        ? discord.bot_token_vault_key.trim()
        : "HDC_HERMES_DISCORD_BOT_TOKEN";
    if (!extraEnv.DISCORD_BOT_TOKEN && (discord.enabled === true || discord.bot_token_vault_key)) {
      extraEnv.DISCORD_BOT_TOKEN = await loadSecret(vault, discordVaultKey, {
        label: "Discord bot token",
      });
    }
  }

  const primaryBackend = resolvePrimaryOllamaBackend(cfg);
  /** @type {string | null} */
  let customApiKey = null;
  if (primaryBackend?.api_key_vault_key) {
    customApiKey = await loadSecret(vault, primaryBackend.api_key_vault_key, {
      label: "custom provider API key (LiteLLM)",
    });
    if (!extraEnv.OPENAI_API_KEY) {
      extraEnv.OPENAI_API_KEY = customApiKey;
    }
  }

  return {
    openrouterApiKey,
    dashboardPassword,
    dashboardAuthSecret,
    customApiKey,
    extraEnv,
    vaultKeys: {
      openrouter: openrouter.vaultKey,
      dashboardPassword: dashboardPasswordKey,
      dashboardAuthSecret: dashboardAuthSecretKey,
      customApi: primaryBackend?.api_key_vault_key ?? null,
    },
  };
}
