import { litellmMailEnvLines } from "hdc/package/app-mail-render.mjs";

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
    throw new Error("litellm.ollama_backends must be an array when set");
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
    out.push({ id, url: url.replace(/\/+$/, "") });
  }
  return out;
}

/**
 * Optional OpenAI-compatible backends (e.g. vLLM). Empty / omitted is allowed when ollama_backends is non-empty.
 * @param {unknown} backends
 * @returns {{ id: string; url: string }[]}
 */
export function normalizeOpenaiBackends(backends) {
  if (backends === undefined || backends === null) return [];
  if (!Array.isArray(backends)) {
    throw new Error("litellm.openai_backends must be an array when set");
  }
  /** @type {{ id: string; url: string }[]} */
  const out = [];
  const seen = new Set();
  for (const raw of backends) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!id || !url) {
      throw new Error("each openai_backends entry needs id and url");
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`openai_backends ${JSON.stringify(id)}: url must be http(s)://…`);
    }
    if (seen.has(id)) {
      throw new Error(`duplicate openai_backends id ${JSON.stringify(id)}`);
    }
    seen.add(id);
    out.push({ id, url: url.replace(/\/+$/, "") });
  }
  return out;
}

/**
 * @param {Record<string, unknown>} litellm
 * @returns {{ ollama: { id: string; url: string }[]; openai: { id: string; url: string }[] }}
 */
export function normalizeBackends(litellm) {
  const cfg = isObject(litellm) ? litellm : {};
  const ollama = normalizeOllamaBackends(cfg.ollama_backends);
  const openai = normalizeOpenaiBackends(cfg.openai_backends);
  if (!ollama.length && !openai.length) {
    throw new Error("litellm needs at least one ollama_backends[] or openai_backends[] entry");
  }
  return { ollama, openai };
}

/**
 * @param {string} backendId
 */
export function ollamaBackendEnvVar(backendId) {
  const slug = backendId.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase();
  return `OLLAMA_API_BASE_${slug || "DEFAULT"}`;
}

/**
 * @param {string} backendId
 */
export function openaiBackendEnvVar(backendId) {
  const slug = backendId.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase();
  return `OPENAI_API_BASE_${slug || "DEFAULT"}`;
}

/**
 * @param {unknown} modelList
 * @param {{ ollama: { id: string; url: string }[]; openai: { id: string; url: string }[] }} backends
 * @returns {{ model_name: string; provider: string; model: string; ollama_backend_id?: string; openai_backend_id?: string; order?: number; weight?: number; complexity_router_config?: Record<string, unknown>; complexity_router_default_model?: string }[]}
 */
export function normalizeModelList(modelList, backends) {
  if (!Array.isArray(modelList) || modelList.length === 0) {
    throw new Error("litellm.model_list must be a non-empty array");
  }
  const ollamaIds = new Set(backends.ollama.map((b) => b.id));
  const openaiIds = new Set(backends.openai.map((b) => b.id));
  /** @type {{ model_name: string; provider: string; model: string; ollama_backend_id?: string; openai_backend_id?: string; order?: number; weight?: number; complexity_router_config?: Record<string, unknown>; complexity_router_default_model?: string }[]} */
  const out = [];
  for (const raw of modelList) {
    if (!isObject(raw)) continue;
    const modelName = typeof raw.model_name === "string" ? raw.model_name.trim() : "";
    const provider = typeof raw.provider === "string" ? raw.provider.trim().toLowerCase() : "";
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    if (!modelName || !provider || !model) {
      throw new Error("each model_list entry needs model_name, provider, and model");
    }
    if (
      provider !== "ollama" &&
      provider !== "openrouter" &&
      provider !== "openai" &&
      provider !== "auto_router"
    ) {
      throw new Error(
        `model_list ${JSON.stringify(modelName)}: provider must be ollama, openai, openrouter, or auto_router`,
      );
    }
    /** @type {{ model_name: string; provider: string; model: string; ollama_backend_id?: string; openai_backend_id?: string; order?: number; weight?: number; complexity_router_config?: Record<string, unknown>; complexity_router_default_model?: string }} */
    const entry = { model_name: modelName, provider, model };
    if (raw.order !== undefined && raw.order !== null) {
      const order = typeof raw.order === "number" ? raw.order : Number(raw.order);
      if (!Number.isFinite(order) || order < 1) {
        throw new Error(`model_list ${JSON.stringify(modelName)}: order must be an integer >= 1`);
      }
      entry.order = Math.floor(order);
    }
    if (raw.weight !== undefined && raw.weight !== null) {
      const weight = typeof raw.weight === "number" ? raw.weight : Number(raw.weight);
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error(`model_list ${JSON.stringify(modelName)}: weight must be a number > 0`);
      }
      entry.weight = weight;
    }
    if (provider === "ollama") {
      const backendId =
        typeof raw.ollama_backend_id === "string"
          ? raw.ollama_backend_id.trim()
          : backends.ollama[0]?.id ?? "";
      if (!backendId || !ollamaIds.has(backendId)) {
        throw new Error(
          `model_list ${JSON.stringify(modelName)}: ollama_backend_id must reference litellm.ollama_backends[].id`,
        );
      }
      entry.ollama_backend_id = backendId;
    } else if (provider === "openai") {
      const backendId =
        typeof raw.openai_backend_id === "string"
          ? raw.openai_backend_id.trim()
          : backends.openai[0]?.id ?? "";
      if (!backendId || !openaiIds.has(backendId)) {
        throw new Error(
          `model_list ${JSON.stringify(modelName)}: openai_backend_id must reference litellm.openai_backends[].id`,
        );
      }
      entry.openai_backend_id = backendId;
    } else if (provider === "auto_router") {
      if (model !== "complexity_router") {
        throw new Error(
          `model_list ${JSON.stringify(modelName)}: auto_router model must be complexity_router`,
        );
      }
      if (isObject(raw.complexity_router_config)) {
        entry.complexity_router_config = /** @type {Record<string, unknown>} */ (
          raw.complexity_router_config
        );
      } else if (raw.complexity_router_config != null) {
        throw new Error(
          `model_list ${JSON.stringify(modelName)}: complexity_router_config must be an object`,
        );
      }
      if (typeof raw.complexity_router_default_model === "string") {
        const def = raw.complexity_router_default_model.trim();
        if (def) entry.complexity_router_default_model = def;
      }
    }
    out.push(entry);
  }
  if (!out.length) {
    throw new Error("litellm.model_list must contain at least one valid entry");
  }
  return out;
}

/**
 * @param {Record<string, unknown>} litellm
 */
export function normalizeImageTag(litellm) {
  const t = typeof litellm.image_tag === "string" ? litellm.image_tag.trim() : "";
  return t || "main-stable";
}

/**
 * @param {Record<string, unknown>} litellm
 */
export function postgresImageTag(litellm) {
  const t = typeof litellm.postgres_image_tag === "string" ? litellm.postgres_image_tag.trim() : "";
  return t || "16";
}

/**
 * @param {Record<string, unknown>} litellm
 */
export function hostPort(litellm) {
  const p = typeof litellm.host_port === "number" ? litellm.host_port : Number(litellm.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 4000;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/litellm";
}

/**
 * @param {Record<string, unknown>} litellm
 * @param {string} keyName
 * @param {string} fallback
 */
function vaultKey(litellm, keyName, fallback) {
  const key = typeof litellm[keyName] === "string" ? litellm[keyName].trim() : "";
  return key || fallback;
}

export function masterKeyVaultKey(litellm) {
  return vaultKey(litellm, "master_key_vault_key", "HDC_LITELLM_MASTER_KEY");
}

export function saltKeyVaultKey(litellm) {
  return vaultKey(litellm, "salt_key_vault_key", "HDC_LITELLM_SALT_KEY");
}

export function dbPasswordVaultKey(litellm) {
  return vaultKey(litellm, "db_password_vault_key", "HDC_LITELLM_DB_PASSWORD");
}

export function openrouterApiKeyVaultKey(litellm) {
  return vaultKey(litellm, "openrouter_api_key_vault_key", "HDC_OPENROUTER_API_KEY");
}

/**
 * @param {Record<string, unknown>} litellm
 * @returns {URL | null}
 */
export function parsePublicUrl(litellm) {
  const raw = typeof litellm.public_url === "string" ? litellm.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`litellm.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("litellm.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} litellm
 * @param {string | null} ctIp
 */
export function resolveApiUrl(litellm, ctIp) {
  const parsed = parsePublicUrl(litellm);
  const port = hostPort(litellm);
  if (parsed) {
    return `${parsed.origin.replace(/\/+$/, "")}/v1`;
  }
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}/v1`;
  return null;
}

/**
 * @param {Record<string, unknown>} litellm
 * @param {string | null} ctIp
 */
export function resolveUiUrl(litellm, ctIp) {
  const parsed = parsePublicUrl(litellm);
  const port = hostPort(litellm);
  if (parsed) {
    return `${parsed.origin.replace(/\/+$/, "")}/ui`;
  }
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}/ui`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} litellm
 */
export function resolveUpstreamUrl(ctIp, litellm) {
  const port = hostPort(litellm);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {Record<string, unknown>} litellm
 * @param {{ masterKey: string; saltKey: string; dbPassword: string; openrouterApiKey?: string | null }} secrets
 */
export function renderLitellmEnv(litellm, secrets) {
  const tag = normalizeImageTag(litellm);
  const pgTag = postgresImageTag(litellm);
  const port = hostPort(litellm);
  const backends = normalizeBackends(litellm);
  normalizeModelList(litellm.model_list, backends);

  const masterKey = String(secrets.masterKey || "").trim();
  const saltKey = String(secrets.saltKey || "").trim();
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!masterKey.startsWith("sk-")) {
    throw new Error("LITELLM_MASTER_KEY must start with sk-");
  }
  if (!saltKey) throw new Error("LITELLM_SALT_KEY is required");
  if (!dbPassword) throw new Error("DATABASE password is required");

  const storeInDb = litellm.store_model_in_db !== false;

  /** @type {string[]} */
  const lines = [
    "# hdc-generated — docker compose",
    `LITELLM_IMAGE_TAG=${tag}`,
    `POSTGRES_IMAGE_TAG=${pgTag}`,
    `LITELLM_HOST_PORT=${port}`,
    `LITELLM_MASTER_KEY=${masterKey}`,
    `LITELLM_SALT_KEY=${saltKey}`,
    `LITELLM_DB_PASSWORD=${dbPassword}`,
    `DATABASE_URL=postgresql://llmproxy:${encodeURIComponent(dbPassword)}@db:5432/litellm`,
    `STORE_MODEL_IN_DB=${storeInDb ? "True" : "False"}`,
  ];

  for (const backend of backends.ollama) {
    lines.push(`${ollamaBackendEnvVar(backend.id)}=${backend.url}`);
  }
  for (const backend of backends.openai) {
    lines.push(`${openaiBackendEnvVar(backend.id)}=${backend.url}`);
  }

  const openrouterKey = secrets.openrouterApiKey ? String(secrets.openrouterApiKey).trim() : "";
  if (openrouterKey) {
    lines.push(`OPENROUTER_API_KEY=${openrouterKey}`);
  }

  lines.push(...litellmMailEnvLines(litellm));

  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  litellm:
    image: docker.litellm.ai/berriai/litellm:\${LITELLM_IMAGE_TAG}
    container_name: litellm
    restart: unless-stopped
    ports:
      - "\${LITELLM_HOST_PORT}:4000"
    volumes:
      - ./config.yaml:/app/config.yaml:ro
    env_file:
      - .env
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "python3 -c \\"import urllib.request; urllib.request.urlopen('http://localhost:4000/health/liveliness')\\"",
        ]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  db:
    image: postgres:\${POSTGRES_IMAGE_TAG}
    container_name: litellm-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: litellm
      POSTGRES_USER: llmproxy
      POSTGRES_PASSWORD: \${LITELLM_DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -d litellm -U llmproxy"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data: {}
`;
}
