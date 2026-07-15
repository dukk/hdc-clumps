/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function normalizeImageTag(paperclip) {
  const t = typeof paperclip.image_tag === "string" ? paperclip.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function normalizePostgresImageTag(paperclip) {
  const t =
    typeof paperclip.postgres_image_tag === "string" ? paperclip.postgres_image_tag.trim() : "";
  if (!t) return "17-alpine";
  return t;
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function hostPort(paperclip) {
  const p = typeof paperclip.host_port === "number" ? paperclip.host_port : Number(paperclip.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3100;
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function deploymentMode(paperclip) {
  const m = typeof paperclip.deployment_mode === "string" ? paperclip.deployment_mode.trim() : "";
  if (m === "local_trusted" || m === "authenticated") return m;
  return "authenticated";
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function deploymentExposure(paperclip) {
  const e = typeof paperclip.deployment_exposure === "string" ? paperclip.deployment_exposure.trim() : "";
  if (e === "private" || e === "public") return e;
  return "private";
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function telemetryDisabled(paperclip) {
  return paperclip.telemetry_disabled !== false;
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function betterAuthSecretVaultKey(paperclip) {
  const key =
    typeof paperclip.better_auth_secret_vault_key === "string" &&
    paperclip.better_auth_secret_vault_key.trim()
      ? paperclip.better_auth_secret_vault_key.trim()
      : "HDC_PAPERCLIP_BETTER_AUTH_SECRET";
  return key;
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function dbPasswordVaultKey(paperclip) {
  const key =
    typeof paperclip.db_password_vault_key === "string" && paperclip.db_password_vault_key.trim()
      ? paperclip.db_password_vault_key.trim()
      : "HDC_PAPERCLIP_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function cursorApiKeyVaultKey(paperclip) {
  const key =
    typeof paperclip.cursor_api_key_vault_key === "string" &&
    paperclip.cursor_api_key_vault_key.trim()
      ? paperclip.cursor_api_key_vault_key.trim()
      : "HDC_PAPERCLIP_CURSOR_API_KEY";
  return key;
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function anthropicApiKeyVaultKey(paperclip) {
  const key =
    typeof paperclip.anthropic_api_key_vault_key === "string" &&
    paperclip.anthropic_api_key_vault_key.trim()
      ? paperclip.anthropic_api_key_vault_key.trim()
      : "HDC_PAPERCLIP_ANTHROPIC_API_KEY";
  return key;
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function openaiApiKeyVaultKey(paperclip) {
  const key =
    typeof paperclip.openai_api_key_vault_key === "string" &&
    paperclip.openai_api_key_vault_key.trim()
      ? paperclip.openai_api_key_vault_key.trim()
      : "HDC_PAPERCLIP_OPENAI_API_KEY";
  return key;
}

/**
 * Optional OpenAI-compatible base URL (e.g. LiteLLM).
 * @param {Record<string, unknown>} paperclip
 */
export function openaiBaseUrl(paperclip) {
  const raw =
    typeof paperclip.openai_base_url === "string" ? paperclip.openai_base_url.trim() : "";
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(`paperclip.openai_base_url must be http(s)://… got ${JSON.stringify(raw)}`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * @param {Record<string, unknown>} paperclip
 */
export function googleGeminiApiKeyVaultKey(paperclip) {
  const key =
    typeof paperclip.google_gemini_api_key_vault_key === "string" &&
    paperclip.google_gemini_api_key_vault_key.trim()
      ? paperclip.google_gemini_api_key_vault_key.trim()
      : "HDC_PAPERCLIP_GOOGLE_GEMINI_API_KEY";
  return key;
}

/**
 * @param {unknown} backends
 * @returns {{ id: string; url: string; primary: boolean }[]}
 */
export function normalizeOllamaBackends(backends) {
  if (!Array.isArray(backends) || backends.length === 0) {
    return [];
  }
  /** @type {{ id: string; url: string; primary: boolean }[]} */
  const out = [];
  const seen = new Set();
  for (const raw of backends) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!id || !url) {
      throw new Error("each paperclip.ollama_backends entry needs id and url");
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`paperclip.ollama_backends ${JSON.stringify(id)}: url must be http(s)://…`);
    }
    if (seen.has(id)) {
      throw new Error(`duplicate paperclip.ollama_backends id ${JSON.stringify(id)}`);
    }
    seen.add(id);
    out.push({ id, url, primary: raw.primary === true });
  }
  if (!out.length) {
    throw new Error("paperclip.ollama_backends must contain at least one valid entry when set");
  }
  return out;
}

/**
 * @param {{ id: string; url: string; primary: boolean }[]} backends
 * @returns {string | null}
 */
export function primaryOllamaBaseUrl(backends) {
  if (!backends.length) return null;
  const marked = backends.find((b) => b.primary);
  if (marked) return marked.url;
  return backends[0].url;
}

/**
 * @param {Record<string, unknown>} paperclip
 * @returns {URL | null}
 */
export function parsePublicUrl(paperclip) {
  const raw = typeof paperclip.public_url === "string" ? paperclip.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`paperclip.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("paperclip.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/paperclip";
}

const DB_USER = "paperclip";
const DB_NAME = "paperclip";

/**
 * @param {Record<string, unknown>} paperclip
 * @param {{ betterAuthSecret: string; dbPassword: string; cursorApiKey?: string; anthropicApiKey?: string; openaiApiKey?: string; googleGeminiApiKey?: string }} secrets
 * @param {string | null} [ctIp]
 */
export function renderPaperclipEnv(paperclip, secrets, ctIp = null) {
  const tag = normalizeImageTag(paperclip);
  const pgTag = normalizePostgresImageTag(paperclip);
  const port = hostPort(paperclip);
  const mode = deploymentMode(paperclip);
  const exposure = deploymentExposure(paperclip);
  const authSecret = String(secrets.betterAuthSecret || "").trim();
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!authSecret) {
    throw new Error("BETTER_AUTH_SECRET is required");
  }
  if (!dbPassword) {
    throw new Error("Paperclip DB password is required");
  }

  const parsed = parsePublicUrl(paperclip);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  const publicUrl = parsed
    ? parsed.origin.replace(/\/+$/, "")
    : ip
      ? `http://${ip}:${port}`
      : `http://localhost:${port}`;

  const lines = [
    "# hdc-generated — docker compose",
    `PAPERCLIP_IMAGE_TAG=${tag}`,
    `POSTGRES_IMAGE_TAG=${pgTag}`,
    `PAPERCLIP_HOST_PORT=${port}`,
    `POSTGRES_USER=${DB_USER}`,
    `POSTGRES_PASSWORD=${dbPassword}`,
    `POSTGRES_DB=${DB_NAME}`,
    `DATABASE_URL=postgres://${DB_USER}:${encodeURIComponent(dbPassword)}@db:5432/${DB_NAME}`,
    "PORT=3100",
    "HOST=0.0.0.0",
    "SERVE_UI=true",
    `PAPERCLIP_DEPLOYMENT_MODE=${mode}`,
    `PAPERCLIP_DEPLOYMENT_EXPOSURE=${exposure}`,
    `PAPERCLIP_PUBLIC_URL=${publicUrl}`,
    `BETTER_AUTH_SECRET=${authSecret}`,
    "NODE_ENV=production",
    "PAPERCLIP_HOME=/paperclip",
    "PAPERCLIP_INSTANCE_ID=default",
    "PAPERCLIP_CONFIG=/paperclip/instances/default/config.json",
  ];

  if (telemetryDisabled(paperclip)) {
    lines.push("PAPERCLIP_TELEMETRY_DISABLED=1", "DO_NOT_TRACK=1");
  }

  const cursorApiKey = String(secrets.cursorApiKey || "").trim();
  if (cursorApiKey) {
    lines.push(`CURSOR_API_KEY=${cursorApiKey}`);
  }

  const anthropicApiKey = String(secrets.anthropicApiKey || "").trim();
  if (anthropicApiKey) {
    lines.push(`ANTHROPIC_API_KEY=${anthropicApiKey}`);
  }

  const openaiApiKey = String(secrets.openaiApiKey || "").trim();
  if (openaiApiKey) {
    lines.push(`OPENAI_API_KEY=${openaiApiKey}`);
  }

  const openaiUrl = openaiBaseUrl(paperclip);
  if (openaiUrl) {
    lines.push(`OPENAI_BASE_URL=${openaiUrl}`);
  }

  const googleGeminiApiKey = String(secrets.googleGeminiApiKey || "").trim();
  if (googleGeminiApiKey) {
    lines.push(`GOOGLE_API_KEY=${googleGeminiApiKey}`);
  }

  const ollamaPrimary = primaryOllamaBaseUrl(normalizeOllamaBackends(paperclip.ollama_backends));
  if (ollamaPrimary) {
    lines.push(`OLLAMA_BASE_URL=${ollamaPrimary}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  db:
    image: postgres:\${POSTGRES_IMAGE_TAG}
    container_name: paperclip_db
    restart: unless-stopped
    ports:
      - "127.0.0.1:5432:5432"
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U paperclip -d paperclip"]
      interval: 2s
      timeout: 5s
      retries: 30
    volumes:
      - paperclip-pgdata:/var/lib/postgresql/data

  server:
    image: ghcr.io/paperclipai/paperclip:\${PAPERCLIP_IMAGE_TAG}
    container_name: paperclip_server
    restart: unless-stopped
    ports:
      - "\${PAPERCLIP_HOST_PORT}:3100"
    env_file:
      - .env
    volumes:
      - paperclip-data:/paperclip
    depends_on:
      db:
        condition: service_healthy

volumes:
  paperclip-pgdata:
  paperclip-data:
`;
}

/**
 * @param {Record<string, unknown>} paperclip
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(paperclip, ctIp = null) {
  const parsed = parsePublicUrl(paperclip);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(paperclip);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} paperclip
 */
export function resolveUpstreamUrl(ctIp, paperclip) {
  const port = hostPort(paperclip);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
