// Compose structure mirrors AFFiNE release docker-compose.yml:
// https://github.com/toeverything/affine/releases/latest/download/docker-compose.yml

import { affineMailEnvLines } from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} affine
 */
export function normalizeRevision(affine) {
  const t = typeof affine.revision === "string" ? affine.revision.trim() : "";
  return t || "stable";
}

/**
 * @param {Record<string, unknown>} affine
 */
export function normalizePostgresImage(affine) {
  const t = typeof affine.postgres_image === "string" ? affine.postgres_image.trim() : "";
  return t || "pgvector/pgvector:pg16";
}

/**
 * @param {Record<string, unknown>} affine
 */
export function normalizeRedisImage(affine) {
  const t = typeof affine.redis_image === "string" ? affine.redis_image.trim() : "";
  return t || "redis:7.4-alpine";
}

/**
 * @param {Record<string, unknown>} affine
 */
export function hostPort(affine) {
  const p = typeof affine.host_port === "number" ? affine.host_port : Number(affine.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3010;
}

/**
 * @param {Record<string, unknown>} affine
 */
export function indexerEnabled(affine) {
  if (affine.indexer_enabled === true) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} affine
 */
export function dbUsername(affine) {
  const u = typeof affine.db_username === "string" ? affine.db_username.trim() : "";
  return u || "affine";
}

/**
 * @param {Record<string, unknown>} affine
 */
export function dbDatabase(affine) {
  const d = typeof affine.db_database === "string" ? affine.db_database.trim() : "";
  return d || "affine";
}

/**
 * @param {Record<string, unknown>} affine
 */
export function dbPasswordVaultKey(affine) {
  const key =
    typeof affine.db_password_vault_key === "string" && affine.db_password_vault_key.trim()
      ? affine.db_password_vault_key.trim()
      : "HDC_AFFINE_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} affine
 * @returns {URL | null}
 */
export function parsePublicUrl(affine) {
  const raw = typeof affine.public_url === "string" ? affine.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`affine.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("affine.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/affine";
}

/**
 * @param {Record<string, unknown>} affine
 * @returns {Record<string, unknown> | null}
 */
export function copilotBlock(affine) {
  if (!isObject(affine.copilot)) return null;
  return /** @type {Record<string, unknown>} */ (affine.copilot);
}

/**
 * @param {Record<string, unknown>} affine
 */
export function copilotEnabled(affine) {
  const c = copilotBlock(affine);
  if (!c) return false;
  return c.enabled === true || c.enabled === 1 || c.enabled === "true";
}

/**
 * @param {Record<string, unknown>} affine
 */
export function copilotApiKeyVaultKey(affine) {
  const c = copilotBlock(affine);
  const key =
    c && typeof c.api_key_vault_key === "string" && c.api_key_vault_key.trim()
      ? c.api_key_vault_key.trim()
      : "HDC_LITELLM_MASTER_KEY";
  return key;
}

/**
 * @param {Record<string, unknown>} affine
 */
export function copilotBaseUrl(affine) {
  const c = copilotBlock(affine);
  const raw = c && typeof c.base_url === "string" ? c.base_url.trim() : "";
  return raw || "http://127.0.0.1:4000/v1";
}

/**
 * @param {Record<string, unknown>} affine
 */
export function copilotModel(affine) {
  const c = copilotBlock(affine);
  const raw = c && typeof c.model === "string" ? c.model.trim() : "";
  return raw || "qwen35-cloud";
}

/**
 * @param {Record<string, unknown>} affine
 */
export function copilotOldApiStyle(affine) {
  const c = copilotBlock(affine);
  if (!c) return true;
  if (c.old_api_style === false || c.old_api_style === 0 || c.old_api_style === "false") {
    return false;
  }
  return true;
}

/**
 * Guest `$CONFIG_LOCATION/config.json` for Copilot → LiteLLM (OpenAI-compatible).
 * @param {Record<string, unknown>} affine
 * @param {{ copilotApiKey?: string }} secrets
 * @returns {string | null} JSON text, or null when copilot disabled
 */
export function renderAffineCopilotConfig(affine, secrets) {
  if (!copilotEnabled(affine)) return null;
  const apiKey = String(secrets.copilotApiKey || "").trim();
  if (!apiKey) {
    throw new Error(
      `AFFiNE copilot.enabled requires vault ${copilotApiKeyVaultKey(affine)}`,
    );
  }
  const doc = {
    $schema: "https://github.com/toeverything/affine/releases/latest/download/config.schema.json",
    copilot: {
      enabled: true,
      "providers.openai": {
        apiKey,
        baseUrl: copilotBaseUrl(affine),
        oldApiStyle: copilotOldApiStyle(affine),
      },
      scenarios: {
        override_enabled: true,
        scenarios: {
          chat: copilotModel(affine),
        },
      },
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * @param {Record<string, unknown>} affine
 * @param {{ dbPassword: string; copilotApiKey?: string }} secrets
 * @param {string} composeDirPath
 */
export function renderAffineEnv(affine, secrets, composeDirPath) {
  const revision = normalizeRevision(affine);
  const port = hostPort(affine);
  const dbUser = dbUsername(affine);
  const dbName = dbDatabase(affine);
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!dbPassword) {
    throw new Error("AFFiNE DB password is required");
  }

  const base = composeDirPath.replace(/\/+$/, "");
  const lines = [
    "# hdc-generated — docker compose",
    `AFFINE_REVISION=${revision}`,
    `PORT=${port}`,
    `DB_DATA_LOCATION=${base}/postgres`,
    `UPLOAD_LOCATION=${base}/storage`,
    `CONFIG_LOCATION=${base}/config`,
    `DB_USERNAME=${dbUser}`,
    `DB_PASSWORD=${dbPassword}`,
    `DB_DATABASE=${dbName}`,
    `AFFINE_INDEXER_ENABLED=${indexerEnabled(affine) ? "true" : "false"}`,
  ];

  const parsed = parsePublicUrl(affine);
  if (parsed) {
    if (parsed.protocol === "https:") {
      lines.push("AFFINE_SERVER_HTTPS=true");
      lines.push(`AFFINE_SERVER_HOST=${parsed.hostname}`);
      lines.push(`AFFINE_SERVER_EXTERNAL_URL=${parsed.origin.replace(/\/+$/, "")}`);
    } else {
      lines.push("AFFINE_SERVER_HTTPS=false");
      lines.push(`AFFINE_SERVER_EXTERNAL_URL=${parsed.origin.replace(/\/+$/, "")}`);
    }
  }

  for (const line of affineMailEnvLines(affine)) {
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `name: affine
services:
  affine:
    image: ghcr.io/toeverything/affine:\${AFFINE_REVISION:-stable}
    container_name: affine_server
    ports:
      - '\${PORT:-3010}:3010'
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy
      affine_migration:
        condition: service_completed_successfully
    volumes:
      - \${UPLOAD_LOCATION}:/root/.affine/storage
      - \${CONFIG_LOCATION}:/root/.affine/config
    env_file:
      - .env
    environment:
      - REDIS_SERVER_HOST=redis
      - DATABASE_URL=postgresql://\${DB_USERNAME}:\${DB_PASSWORD}@postgres:5432/\${DB_DATABASE:-affine}
      - AFFINE_INDEXER_ENABLED=\${AFFINE_INDEXER_ENABLED:-false}
    restart: unless-stopped

  affine_migration:
    image: ghcr.io/toeverything/affine:\${AFFINE_REVISION:-stable}
    container_name: affine_migration_job
    volumes:
      - \${UPLOAD_LOCATION}:/root/.affine/storage
      - \${CONFIG_LOCATION}:/root/.affine/config
    command: ['sh', '-c', 'node ./scripts/self-host-predeploy.js']
    env_file:
      - .env
    environment:
      - REDIS_SERVER_HOST=redis
      - DATABASE_URL=postgresql://\${DB_USERNAME}:\${DB_PASSWORD}@postgres:5432/\${DB_DATABASE:-affine}
      - AFFINE_INDEXER_ENABLED=\${AFFINE_INDEXER_ENABLED:-false}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  redis:
    image: \${REDIS_IMAGE}
    container_name: affine_redis
    healthcheck:
      test: ['CMD', 'redis-cli', '--raw', 'incr', 'ping']
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  postgres:
    image: \${POSTGRES_IMAGE}
    container_name: affine_postgres
    volumes:
      - \${DB_DATA_LOCATION}:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: \${DB_USERNAME}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: \${DB_DATABASE:-affine}
      POSTGRES_INITDB_ARGS: '--data-checksums'
      POSTGRES_HOST_AUTH_METHOD: trust
    healthcheck:
      test: ['CMD', 'pg_isready', '-U', "\${DB_USERNAME}", '-d', "\${DB_DATABASE:-affine}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
`;
}

/**
 * Extended env for compose image pins (appended to .env after renderAffineEnv).
 * @param {Record<string, unknown>} affine
 */
export function renderComposeImageEnv(affine) {
  return [
    `POSTGRES_IMAGE=${normalizePostgresImage(affine)}`,
    `REDIS_IMAGE=${normalizeRedisImage(affine)}`,
  ].join("\n");
}

/**
 * @param {Record<string, unknown>} affine
 * @param {{ dbPassword: string; copilotApiKey?: string }} secrets
 * @param {string} composeDirPath
 */
export function renderFullEnv(affine, secrets, composeDirPath) {
  const base = renderAffineEnv(affine, secrets, composeDirPath).trimEnd();
  const images = renderComposeImageEnv(affine);
  return `${base}\n${images}\n`;
}

/**
 * @param {Record<string, unknown>} affine
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(affine, ctIp = null) {
  const parsed = parsePublicUrl(affine);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(affine);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} affine
 */
export function resolveUpstreamUrl(ctIp, affine) {
  const port = hostPort(affine);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
