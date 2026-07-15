/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Optional Ollama backends. Empty / omitted is allowed when openai_backends is non-empty.
 * @param {unknown} backends
 * @returns {{ id: string; url: string }[]}
 */
export function normalizeOllamaBackends(backends) {
  if (backends === undefined || backends === null) return [];
  if (!Array.isArray(backends)) {
    throw new Error("open_webui.ollama_backends must be an array when set");
  }
  /** @type {{ id: string; url: string }[]} */
  const out = [];
  const seen = new Set();
  for (const raw of backends) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!id || !url) {
      throw new Error("each ollama_backends entry needs id and url");
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`ollama_backends ${JSON.stringify(id)}: url must be http(s)://…`);
    }
    if (seen.has(id)) {
      throw new Error(`duplicate ollama_backends id ${JSON.stringify(id)}`);
    }
    seen.add(id);
    out.push({ id, url });
  }
  return out;
}

/**
 * @param {{ id: string; url: string }[]} backends
 */
export function ollamaBaseUrlsJoined(backends) {
  return backends.map((b) => b.url).join(";");
}

/**
 * Optional OpenAI-compatible backends (e.g. LiteLLM). Empty / omitted is allowed.
 * @param {unknown} backends
 * @returns {{ id: string; url: string; api_key_vault_key: string; model_ids: string[] }[]}
 */
export function normalizeOpenaiBackends(backends) {
  if (backends === undefined || backends === null) return [];
  if (!Array.isArray(backends)) {
    throw new Error("open_webui.openai_backends must be an array when set");
  }
  /** @type {{ id: string; url: string; api_key_vault_key: string; model_ids: string[] }[]} */
  const out = [];
  const seen = new Set();
  for (const raw of backends) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    const apiKeyVaultKey =
      typeof raw.api_key_vault_key === "string" ? raw.api_key_vault_key.trim() : "";
    if (!id || !url) {
      throw new Error("each openai_backends entry needs id and url");
    }
    if (!apiKeyVaultKey) {
      throw new Error(`openai_backends ${JSON.stringify(id)}: api_key_vault_key required`);
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`openai_backends ${JSON.stringify(id)}: url must be http(s)://…`);
    }
    if (seen.has(id)) {
      throw new Error(`duplicate openai_backends id ${JSON.stringify(id)}`);
    }
    seen.add(id);
    /** @type {string[]} */
    const modelIds = [];
    if (Array.isArray(raw.model_ids)) {
      for (const m of raw.model_ids) {
        if (typeof m === "string" && m.trim()) modelIds.push(m.trim());
      }
    }
    out.push({ id, url, api_key_vault_key: apiKeyVaultKey, model_ids: modelIds });
  }
  return out;
}

/**
 * Collect unique vault key names from openai_backends across open_webui blocks.
 * @param {Record<string, unknown>} openWebui
 * @returns {string[]}
 */
export function openaiApiKeyVaultKeys(openWebui) {
  const backends = normalizeOpenaiBackends(openWebui.openai_backends);
  const keys = [];
  const seen = new Set();
  for (const b of backends) {
    if (seen.has(b.api_key_vault_key)) continue;
    seen.add(b.api_key_vault_key);
    keys.push(b.api_key_vault_key);
  }
  return keys;
}

/**
 * @param {Record<string, unknown>} openWebui
 */
export function normalizeImageTag(openWebui) {
  const t = typeof openWebui.image_tag === "string" ? openWebui.image_tag.trim() : "";
  if (!t) return "main";
  return t;
}

/**
 * @param {Record<string, unknown>} openWebui
 */
export function hostPort(openWebui) {
  const p = typeof openWebui.host_port === "number" ? openWebui.host_port : Number(openWebui.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3000;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/open-webui";
}

/**
 * @param {Record<string, unknown>} openWebui
 */
export function secretKeyVaultKey(openWebui) {
  const key =
    typeof openWebui.secret_key_vault_key === "string" && openWebui.secret_key_vault_key.trim()
      ? openWebui.secret_key_vault_key.trim()
      : "HDC_OPEN_WEBUI_SECRET_KEY";
  return key;
}

/**
 * Escape a value for a docker compose .env line (no newlines).
 * @param {string} value
 */
function envValue(value) {
  return String(value).replace(/\r?\n/g, "");
}

/**
 * @param {Record<string, unknown>} openWebui
 * @param {string} secretKey
 * @param {Record<string, string>} [openaiKeysById] map of openai_backends id → API key
 */
export function renderOpenWebuiEnv(openWebui, secretKey, openaiKeysById = {}) {
  const backends = normalizeOllamaBackends(openWebui.ollama_backends);
  const openaiBackends = normalizeOpenaiBackends(openWebui.openai_backends);
  if (!backends.length && !openaiBackends.length) {
    throw new Error("open_webui needs at least one ollama_backends[] or openai_backends[] entry");
  }
  const tag = normalizeImageTag(openWebui);
  const port = hostPort(openWebui);
  const webuiAuth = openWebui.webui_auth !== false;

  const lines = [
    `# hdc-generated — docker compose`,
    `OPEN_WEBUI_IMAGE_TAG=${tag}`,
    `OPEN_WEBUI_HOST_PORT=${port}`,
    `WEBUI_SECRET_KEY=${envValue(secretKey)}`,
    "K8S_FLAG=false",
    "SCARF_NO_ANALYTICS=true",
    "DO_NOT_TRACK=true",
    "ANONYMIZED_TELEMETRY=false",
    `WEBUI_AUTH=${webuiAuth ? "true" : "false"}`,
  ];

  if (backends.length) {
    const urls = ollamaBaseUrlsJoined(backends);
    const primary = backends[0].url;
    lines.push(`OLLAMA_BASE_URL=${primary}`);
    lines.push(`OLLAMA_BASE_URLS=${urls}`);
  } else {
    lines.push("ENABLE_OLLAMA_API=false");
  }

  if (openaiBackends.length) {
    const baseUrls = [];
    const apiKeys = [];
    /** @type {Record<string, { enable: boolean; model_ids?: string[]; prefix_id?: string }>} */
    const configs = {};
    let hasModelFilter = false;
    for (let i = 0; i < openaiBackends.length; i++) {
      const b = openaiBackends[i];
      const key = openaiKeysById[b.id];
      if (!key) {
        throw new Error(`openai_backends ${JSON.stringify(b.id)}: missing API key for vault ${b.api_key_vault_key}`);
      }
      baseUrls.push(b.url);
      apiKeys.push(key);
      /** @type {{ enable: boolean; model_ids?: string[]; prefix_id?: string }} */
      const cfg = { enable: true, prefix_id: b.id };
      if (b.model_ids.length) {
        cfg.model_ids = b.model_ids;
        hasModelFilter = true;
      }
      configs[String(i)] = cfg;
    }
    lines.push("ENABLE_OPENAI_API=true");
    lines.push(`OPENAI_API_BASE_URLS=${envValue(baseUrls.join(";"))}`);
    lines.push(`OPENAI_API_KEYS=${envValue(apiKeys.join(";"))}`);
    if (hasModelFilter) {
      lines.push(`OPENAI_API_CONFIGS=${envValue(JSON.stringify(configs))}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Minimal compose: Open WebUI only (no bundled Ollama).
 */
export function renderComposeYaml() {
  return `services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:\${OPEN_WEBUI_IMAGE_TAG}
    container_name: open-webui
    restart: unless-stopped
    ports:
      - "\${OPEN_WEBUI_HOST_PORT}:8080"
    volumes:
      - open-webui:/app/backend/data
    env_file:
      - .env

volumes:
  open-webui: {}
`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} openWebui
 */
export function resolveWebUiUrl(ctIp, openWebui) {
  const port = hostPort(openWebui);
  if (typeof openWebui.public_url === "string" && openWebui.public_url.trim()) {
    return openWebui.public_url.trim();
  }
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
