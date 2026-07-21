import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createSlackManifestClient, rotateSlackConfigTokens } from "./slack-api.mjs";
import { CLUMP_CONFIG_EXAMPLE, normalizeSlackConfig } from "./slack-config.mjs";
import {
  createSlackVaultAccess,
  resolveSlackVaultSecret,
  writeSlackVaultSecret,
} from "./vault-deps.mjs";

export { CLUMP_CONFIG_EXAMPLE };

/**
 * @param {unknown} cfgRaw
 * @param {{
 *   rotateTokens?: boolean,
 *   log?: (line: string) => void,
 *   fetchFn?: typeof fetch,
 * }} [opts]
 */
export async function createSlackRunContext(cfgRaw, opts = {}) {
  const config = normalizeSlackConfig(cfgRaw);
  const vault = createSlackVaultAccess();
  const log = opts.log ?? (() => {});

  let token = await resolveSlackVaultSecret(vault, config.config_token_vault_key, {
    required: false,
  });
  const refresh = await resolveSlackVaultSecret(
    vault,
    config.config_refresh_token_vault_key,
    { required: false },
  );

  if (!token && refresh && opts.rotateTokens !== false) {
    log("config token missing; rotating via refresh token");
    const rotated = await rotateSlackConfigTokens({
      refreshToken: refresh,
      apiBase: config.api_base_url,
      fetchFn: opts.fetchFn,
    });
    token = rotated.token;
    await writeSlackVaultSecret(vault, config.config_token_vault_key, rotated.token);
    if (rotated.refresh_token) {
      await writeSlackVaultSecret(
        vault,
        config.config_refresh_token_vault_key,
        rotated.refresh_token,
      );
    }
  }

  if (!token) {
    throw new Error(
      `Set ${config.config_token_vault_key} (and ${config.config_refresh_token_vault_key}) — create App Configuration Tokens at api.slack.com/apps`,
    );
  }

  // Proactive rotate when refresh present (tokens expire ~12h).
  if (refresh && opts.rotateTokens !== false) {
    try {
      const rotated = await rotateSlackConfigTokens({
        refreshToken: refresh,
        apiBase: config.api_base_url,
        fetchFn: opts.fetchFn,
      });
      token = rotated.token;
      await writeSlackVaultSecret(vault, config.config_token_vault_key, rotated.token);
      if (rotated.refresh_token) {
        await writeSlackVaultSecret(
          vault,
          config.config_refresh_token_vault_key,
          rotated.refresh_token,
        );
      }
      log("rotated Slack config tokens");
    } catch (e) {
      log(
        `config token rotate skipped: ${e instanceof Error ? e.message : String(e)} (using existing token)`,
      );
    }
  }

  const api = createSlackManifestClient({
    token,
    apiBase: config.api_base_url,
    fetchFn: opts.fetchFn,
  });

  return { config, vault, api };
}

/**
 * Best-effort hdc-agents public_url for interactivity URL derivation.
 *
 * @param {string} [privateRoot]
 * @param {string} [hdcRoot]
 */
export function loadHdcAgentsPublicUrl(privateRoot, hdcRoot) {
  for (const root of [privateRoot, hdcRoot].filter(Boolean)) {
    const p = join(
      /** @type {string} */ (root),
      "clumps",
      "services",
      "hdc-agents",
      "config.json",
    );
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      const agents = raw?.defaults?.hdc_agents ?? raw?.hdc_agents;
      const url = typeof agents?.public_url === "string" ? agents.public_url.trim() : "";
      if (url) return url.replace(/\/+$/, "");
    } catch {
      /* next */
    }
  }
  return String(process.env.HDC_WEB_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
}
