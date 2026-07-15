import { randomBytes } from "node:crypto";

import { twentyMailEnvLines } from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function normalizeImageTag(twenty) {
  const t = typeof twenty.image_tag === "string" ? twenty.image_tag.trim() : "";
  if (!t) return "v2.11.0";
  return t;
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function normalizePostgresImageTag(twenty) {
  const t =
    typeof twenty.postgres_image_tag === "string" ? twenty.postgres_image_tag.trim() : "";
  if (!t) return "16";
  return t;
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function normalizeRedisImageTag(twenty) {
  const t = typeof twenty.redis_image_tag === "string" ? twenty.redis_image_tag.trim() : "";
  if (!t) return "7-alpine";
  return t;
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function hostPort(twenty) {
  const p = typeof twenty.host_port === "number" ? twenty.host_port : Number(twenty.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3000;
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function encryptionKeyVaultKey(twenty) {
  const key =
    typeof twenty.encryption_key_vault_key === "string" && twenty.encryption_key_vault_key.trim()
      ? twenty.encryption_key_vault_key.trim()
      : "HDC_TWENTY_ENCRYPTION_KEY";
  return key;
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function fallbackEncryptionKeyVaultKey(twenty) {
  const key =
    typeof twenty.fallback_encryption_key_vault_key === "string" &&
    twenty.fallback_encryption_key_vault_key.trim()
      ? twenty.fallback_encryption_key_vault_key.trim()
      : "HDC_TWENTY_ENCRYPTION_KEY_FALLBACK";
  return key;
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function dbPasswordVaultKey(twenty) {
  const key =
    typeof twenty.db_password_vault_key === "string" && twenty.db_password_vault_key.trim()
      ? twenty.db_password_vault_key.trim()
      : "HDC_TWENTY_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function normalizeDbUser(twenty) {
  const u = typeof twenty.db_user === "string" ? twenty.db_user.trim() : "";
  return u || "postgres";
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function normalizeDbName(twenty) {
  const n = typeof twenty.db_name === "string" ? twenty.db_name.trim() : "";
  return n || "default";
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function normalizeStorageType(twenty) {
  const t = typeof twenty.storage_type === "string" ? twenty.storage_type.trim().toLowerCase() : "";
  if (t === "s3") return "S_3";
  return "local";
}

/**
 * @param {Record<string, unknown>} twenty
 */
export function multiWorkspaceEnabled(twenty) {
  return twenty.multi_workspace_enabled === true;
}

/**
 * @param {Record<string, unknown>} twenty
 * @returns {URL | null}
 */
export function parsePublicUrl(twenty) {
  const raw = typeof twenty.public_url === "string" ? twenty.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`twenty.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("twenty.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/twenty";
}

/**
 * @param {Record<string, unknown>} twenty
 * @param {string | null} [ctIp]
 */
export function resolveServerUrl(twenty, ctIp = null) {
  const parsed = parsePublicUrl(twenty);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(twenty);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return "http://localhost:3000";
}

/**
 * @param {Record<string, unknown>} twenty
 * @param {{ encryptionKey: string; dbPassword: string; fallbackEncryptionKey?: string | null }} secrets
 * @param {string | null} [ctIp]
 */
export function renderTwentyEnv(twenty, secrets, ctIp = null) {
  const tag = normalizeImageTag(twenty);
  const pgTag = normalizePostgresImageTag(twenty);
  const redisTag = normalizeRedisImageTag(twenty);
  const port = hostPort(twenty);
  const dbUser = normalizeDbUser(twenty);
  const dbName = normalizeDbName(twenty);
  const encryptionKey = String(secrets.encryptionKey || "").trim();
  const dbPassword = String(secrets.dbPassword || "").trim();
  const fallbackEncryptionKey =
    secrets.fallbackEncryptionKey != null ? String(secrets.fallbackEncryptionKey).trim() : "";
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY is required");
  }
  if (!dbPassword) {
    throw new Error("PG_DATABASE_PASSWORD is required");
  }

  const serverUrl = resolveServerUrl(twenty, ctIp);
  const storageType = normalizeStorageType(twenty);
  const s3 = isObject(twenty.storage_s3) ? twenty.storage_s3 : {};

  /** @type {string[]} */
  const lines = [
    "# hdc-generated — docker compose",
    `TAG=${tag}`,
    `POSTGRES_IMAGE_TAG=${pgTag}`,
    `REDIS_IMAGE_TAG=${redisTag}`,
    `TWENTY_HOST_PORT=${port}`,
    `SERVER_URL=${serverUrl}`,
    `ENCRYPTION_KEY=${encryptionKey}`,
  ];
  if (fallbackEncryptionKey) {
    lines.push(`FALLBACK_ENCRYPTION_KEY=${fallbackEncryptionKey}`);
  }
  lines.push(
    `PG_DATABASE_USER=${dbUser}`,
    `PG_DATABASE_PASSWORD=${dbPassword}`,
    `PG_DATABASE_NAME=${dbName}`,
    `PG_DATABASE_HOST=db`,
    `PG_DATABASE_PORT=5432`,
    `REDIS_URL=redis://redis:6379`,
    `STORAGE_TYPE=${storageType}`,
    "DISABLE_DB_MIGRATIONS=",
    "DISABLE_CRON_JOBS_REGISTRATION=",
    `IS_MULTIWORKSPACE_ENABLED=${multiWorkspaceEnabled(twenty) ? "true" : "false"}`,
  );

  if (storageType === "S_3" && s3.enabled !== false) {
    const region = typeof s3.region === "string" ? s3.region.trim() : "";
    const bucket = typeof s3.bucket === "string" ? s3.bucket.trim() : "";
    const endpoint = typeof s3.endpoint === "string" ? s3.endpoint.trim() : "";
    lines.push(`STORAGE_S3_REGION=${region}`);
    lines.push(`STORAGE_S3_NAME=${bucket}`);
    lines.push(`STORAGE_S3_ENDPOINT=${endpoint}`);
    lines.push("STORAGE_S3_ACCESS_KEY_ID=");
    lines.push("STORAGE_S3_SECRET_ACCESS_KEY=");
  } else {
    lines.push("STORAGE_S3_REGION=");
    lines.push("STORAGE_S3_NAME=");
    lines.push("STORAGE_S3_ENDPOINT=");
  }

  for (const line of twentyMailEnvLines(twenty)) {
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `name: twenty

services:
  server:
    image: twentycrm/twenty:\${TAG}
    container_name: twenty_server
    volumes:
      - server-local-data:/app/packages/twenty-server/.local-storage
    ports:
      - "\${TWENTY_HOST_PORT}:3000"
    env_file:
      - .env
    environment:
      NODE_PORT: 3000
      PG_DATABASE_URL: postgres://\${PG_DATABASE_USER}:\${PG_DATABASE_PASSWORD}@\${PG_DATABASE_HOST}:\${PG_DATABASE_PORT}/\${PG_DATABASE_NAME}
      SERVER_URL: \${SERVER_URL}
      REDIS_URL: \${REDIS_URL}
      DISABLE_DB_MIGRATIONS: \${DISABLE_DB_MIGRATIONS}
      DISABLE_CRON_JOBS_REGISTRATION: \${DISABLE_CRON_JOBS_REGISTRATION}
      STORAGE_TYPE: \${STORAGE_TYPE}
      STORAGE_S3_REGION: \${STORAGE_S3_REGION}
      STORAGE_S3_NAME: \${STORAGE_S3_NAME}
      STORAGE_S3_ENDPOINT: \${STORAGE_S3_ENDPOINT}
      ENCRYPTION_KEY: \${ENCRYPTION_KEY}
      IS_MULTIWORKSPACE_ENABLED: \${IS_MULTIWORKSPACE_ENABLED}
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: curl --fail http://localhost:3000/healthz
      interval: 5s
      timeout: 5s
      retries: 40
      start_period: 120s
    restart: always

  worker:
    image: twentycrm/twenty:\${TAG}
    container_name: twenty_worker
    volumes:
      - server-local-data:/app/packages/twenty-server/.local-storage
    command: ["yarn", "worker:prod"]
    env_file:
      - .env
    environment:
      PG_DATABASE_URL: postgres://\${PG_DATABASE_USER}:\${PG_DATABASE_PASSWORD}@\${PG_DATABASE_HOST}:\${PG_DATABASE_PORT}/\${PG_DATABASE_NAME}
      SERVER_URL: \${SERVER_URL}
      REDIS_URL: \${REDIS_URL}
      DISABLE_DB_MIGRATIONS: "true"
      DISABLE_CRON_JOBS_REGISTRATION: "true"
      STORAGE_TYPE: \${STORAGE_TYPE}
      STORAGE_S3_REGION: \${STORAGE_S3_REGION}
      STORAGE_S3_NAME: \${STORAGE_S3_NAME}
      STORAGE_S3_ENDPOINT: \${STORAGE_S3_ENDPOINT}
      ENCRYPTION_KEY: \${ENCRYPTION_KEY}
      IS_MULTIWORKSPACE_ENABLED: \${IS_MULTIWORKSPACE_ENABLED}
    depends_on:
      db:
        condition: service_healthy
      server:
        condition: service_started
    restart: always

  db:
    image: postgres:\${POSTGRES_IMAGE_TAG}
    container_name: twenty_db
    volumes:
      - db-data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: \${PG_DATABASE_NAME}
      POSTGRES_PASSWORD: \${PG_DATABASE_PASSWORD}
      POSTGRES_USER: \${PG_DATABASE_USER}
    healthcheck:
      test: pg_isready -U \${PG_DATABASE_USER} -h localhost -d postgres
      interval: 5s
      timeout: 5s
      retries: 10
    restart: always

  redis:
    image: redis:\${REDIS_IMAGE_TAG}
    container_name: twenty_redis
    restart: always
    command: ["--maxmemory-policy", "noeviction"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  db-data:
  server-local-data:
`;
}

/**
 * @param {Record<string, unknown>} twenty
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(twenty, ctIp = null) {
  return resolveServerUrl(twenty, ctIp);
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} twenty
 */
export function resolveUpstreamUrl(ctIp, twenty) {
  const port = hostPort(twenty);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * Generate a Postgres password safe for Twenty (no special characters).
 * @returns {string}
 */
export function generateTwentyDbPassword() {
  return randomBytes(32).toString("hex");
}
