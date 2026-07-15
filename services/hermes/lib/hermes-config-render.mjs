import { dataDir } from "./hermes-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} url
 */
function normalizeOllamaBaseUrl(url) {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`ollama backend url must be http(s)://… got ${JSON.stringify(url)}`);
  }
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

/**
 * @param {Record<string, unknown>} hermes
 * @returns {{ id: string; base_url: string; api_key_vault_key: string | null; backends: { id: string; url: string }[] } | null}
 */
export function resolvePrimaryOllamaBackend(hermes) {
  const raw = hermes.ollama_backends;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  /** @type {{ id: string; url: string; primary: boolean; api_key_vault_key: string | null }[]} */
  const backends = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!id || !url) continue;
    const apiKeyVaultKey =
      typeof item.api_key_vault_key === "string" && item.api_key_vault_key.trim()
        ? item.api_key_vault_key.trim()
        : null;
    backends.push({
      id,
      url,
      primary: item.primary === true,
      api_key_vault_key: apiKeyVaultKey,
    });
  }
  if (!backends.length) return null;

  const primary = backends.find((b) => b.primary) ?? backends[0];
  return {
    id: primary.id,
    base_url: normalizeOllamaBaseUrl(primary.url),
    api_key_vault_key: primary.api_key_vault_key,
    backends: backends.map((b) => ({ id: b.id, url: b.url })),
  };
}

/**
 * @param {string} s
 */
function yamlQuote(s) {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {number} indent
 */
function yamlLine(key, value, indent = 0) {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return `${pad}${key}: ${value ? "true" : "false"}`;
  if (typeof value === "number" && Number.isFinite(value)) return `${pad}${key}: ${value}`;
  return `${pad}${key}: ${yamlQuote(String(value))}`;
}

/**
 * Build Hermes Agent config.yaml content (non-secret settings).
 * @param {Record<string, unknown>} hermes
 * @param {{ apiKey?: string | null }} [opts]
 */
export function renderHermesConfigYaml(hermes, opts = {}) {
  const cfg = isObject(hermes) ? hermes : {};
  const modelBlock = isObject(cfg.model) ? cfg.model : {};
  const ollama = resolvePrimaryOllamaBackend(cfg);
  const apiKey = typeof opts.apiKey === "string" && opts.apiKey.trim() ? opts.apiKey.trim() : "";

  const defaultModel =
    typeof modelBlock.default === "string" && modelBlock.default.trim()
      ? modelBlock.default.trim()
      : typeof cfg.model_default === "string" && cfg.model_default.trim()
        ? cfg.model_default.trim()
        : "";

  if (ollama && !defaultModel) {
    throw new Error(
      "hermes.model.default is required when hermes.ollama_backends[] is configured — set the model id (e.g. gemma4-e4b)",
    );
  }

  /** @type {string[]} */
  const lines = ["# hdc-generated — Hermes Agent config.yaml"];

  if (ollama || defaultModel) {
    lines.push("model:");
    if (defaultModel) lines.push(yamlLine("default", defaultModel, 2));
    if (ollama) {
      lines.push(yamlLine("provider", "custom", 2));
      lines.push(yamlLine("base_url", ollama.base_url, 2));
      if (apiKey) {
        lines.push(yamlLine("api_key", apiKey, 2));
      }
    }
    const ctx =
      typeof modelBlock.context_length === "number"
        ? modelBlock.context_length
        : Number(modelBlock.context_length);
    if (Number.isFinite(ctx) && ctx > 0) {
      lines.push(yamlLine("context_length", Math.floor(ctx), 2));
    }
  }

  const fallbacks = Array.isArray(cfg.fallback_providers) ? cfg.fallback_providers : [];
  const validFallbacks = fallbacks.filter(isObject).filter((f) => {
    const provider = typeof f.provider === "string" ? f.provider.trim() : "";
    const model = typeof f.model === "string" ? f.model.trim() : "";
    return provider && model;
  });
  if (validFallbacks.length > 0) {
    lines.push("fallback_providers:");
    for (const f of validFallbacks) {
      lines.push("  -");
      lines.push(yamlLine("provider", String(f.provider).trim(), 4));
      lines.push(yamlLine("model", String(f.model).trim(), 4));
    }
  }

  const agent = isObject(cfg.agent) ? cfg.agent : {};
  const apiTimeout =
    typeof agent.api_timeout === "number" ? agent.api_timeout : Number(agent.api_timeout);
  if (Number.isFinite(apiTimeout) && apiTimeout > 0) {
    lines.push("agent:");
    lines.push(yamlLine("api_timeout", Math.floor(apiTimeout), 2));
  }

  const discord = isObject(cfg.discord) ? cfg.discord : {};
  if (discord.enabled !== false && (discord.enabled === true || discord.bot_token_vault_key)) {
    lines.push("discord:");
    if (discord.require_mention !== undefined) {
      lines.push(yamlLine("require_mention", discord.require_mention !== false, 2));
    }
    if (typeof discord.free_response_channels === "string" && discord.free_response_channels.trim()) {
      lines.push(yamlLine("free_response_channels", discord.free_response_channels.trim(), 2));
    }
    if (discord.auto_thread !== undefined) {
      lines.push(yamlLine("auto_thread", discord.auto_thread !== false, 2));
    }
  }

  const configExtra = isObject(cfg.config_extra) ? cfg.config_extra : {};
  for (const [key, val] of Object.entries(configExtra)) {
    if (val === null || val === undefined) continue;
    if (typeof val === "object") continue;
    lines.push(yamlLine(key, val, 0));
  }

  return `${lines.filter(Boolean).join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} install
 * @param {string} configYaml
 */
export function buildConfigYamlScript(install, configYaml) {
  const data = dataDir(install).replace(/'/g, `'\\''`);
  return [
    `mkdir -p '${data}'`,
    `cat > '${data}/config.yaml' <<'HDCCONFIG'`,
    configYaml.trimEnd(),
    "HDCCONFIG",
    `chmod 600 '${data}/config.yaml'`,
  ].join("\n");
}
