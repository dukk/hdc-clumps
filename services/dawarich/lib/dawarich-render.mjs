/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function normalizeImageTag(dawarich) {
  const t = typeof dawarich.image_tag === "string" ? dawarich.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function normalizePostgisImageTag(dawarich) {
  const t =
    typeof dawarich.postgis_image_tag === "string" ? dawarich.postgis_image_tag.trim() : "";
  if (!t) return "17-3.5-alpine";
  return t;
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function normalizeRedisImageTag(dawarich) {
  const t = typeof dawarich.redis_image_tag === "string" ? dawarich.redis_image_tag.trim() : "";
  if (!t) return "7.4-alpine";
  return t;
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function hostPort(dawarich) {
  const p = typeof dawarich.host_port === "number" ? dawarich.host_port : Number(dawarich.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3000;
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function railsEnv(dawarich) {
  const e = typeof dawarich.rails_env === "string" ? dawarich.rails_env.trim() : "";
  if (e === "development" || e === "staging" || e === "production") return e;
  return "production";
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function databaseName(dawarich) {
  const custom =
    typeof dawarich.database_name === "string" ? dawarich.database_name.trim() : "";
  if (custom) return custom;
  const env = railsEnv(dawarich);
  if (env === "development") return "dawarich_development";
  if (env === "staging") return "dawarich_staging";
  return "dawarich_production";
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function timeZone(dawarich) {
  const tz = typeof dawarich.time_zone === "string" ? dawarich.time_zone.trim() : "";
  return tz || "America/Chicago";
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function storeGeodata(dawarich) {
  return dawarich.store_geodata !== false;
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function secretKeyBaseVaultKey(dawarich) {
  const key =
    typeof dawarich.secret_key_base_vault_key === "string" &&
    dawarich.secret_key_base_vault_key.trim()
      ? dawarich.secret_key_base_vault_key.trim()
      : "HDC_DAWARICH_SECRET_KEY_BASE";
  return key;
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function dbPasswordVaultKey(dawarich) {
  const key =
    typeof dawarich.db_password_vault_key === "string" && dawarich.db_password_vault_key.trim()
      ? dawarich.db_password_vault_key.trim()
      : "HDC_DAWARICH_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} dawarich
 * @returns {URL | null}
 */
export function parsePublicUrl(dawarich) {
  const raw = dawarich.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`dawarich.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("dawarich.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/dawarich";
}

/**
 * @param {Record<string, unknown>} dawarich
 * @param {string | null} [ctIp]
 */
export function applicationHosts(dawarich, ctIp = null) {
  /** @type {Set<string>} */
  const hosts = new Set(["localhost", "::1", "127.0.0.1"]);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) hosts.add(ip);
  const parsed = parsePublicUrl(dawarich);
  if (parsed?.hostname) hosts.add(parsed.hostname);
  return [...hosts].join(",");
}

/**
 * @param {Record<string, unknown>} dawarich
 */
export function applicationProtocol(dawarich) {
  const parsed = parsePublicUrl(dawarich);
  if (parsed?.protocol === "https:") return "https";
  if (parsed?.protocol === "http:") return "http";
  const override =
    typeof dawarich.application_protocol === "string"
      ? dawarich.application_protocol.trim().toLowerCase()
      : "";
  if (override === "https" || override === "http") return override;
  return "http";
}

/**
 * @param {Record<string, unknown>} dawarich
 * @param {{ secretKeyBase: string; dbPassword: string }} secrets
 * @param {string | null} [ctIp]
 */
export function renderDawarichEnv(dawarich, secrets, ctIp = null) {
  const tag = normalizeImageTag(dawarich);
  const postgisTag = normalizePostgisImageTag(dawarich);
  const redisTag = normalizeRedisImageTag(dawarich);
  const port = hostPort(dawarich);
  const env = railsEnv(dawarich);
  const dbName = databaseName(dawarich);
  const secretKeyBase = String(secrets.secretKeyBase || "").trim();
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!secretKeyBase) {
    throw new Error("SECRET_KEY_BASE is required");
  }
  if (!dbPassword) {
    throw new Error("Dawarich DB password is required");
  }

  const appHosts = applicationHosts(dawarich, ctIp);
  const appProtocol = applicationProtocol(dawarich);
  const tz = timeZone(dawarich);
  const geodata = storeGeodata(dawarich) ? "true" : "false";
  const cpuLimit =
    typeof dawarich.app_cpu_limit === "string" && dawarich.app_cpu_limit.trim()
      ? dawarich.app_cpu_limit.trim()
      : "0.50";
  const memLimit =
    typeof dawarich.app_memory_limit === "string" && dawarich.app_memory_limit.trim()
      ? dawarich.app_memory_limit.trim()
      : "4G";

  const lines = [
    "# hdc-generated — docker compose",
    `DAWARICH_IMAGE_TAG=${tag}`,
    `POSTGIS_IMAGE_TAG=${postgisTag}`,
    `REDIS_IMAGE_TAG=${redisTag}`,
    `DAWARICH_APP_PORT=${port}`,
    `RAILS_ENV=${env}`,
    "POSTGRES_USER=postgres",
    `POSTGRES_PASSWORD=${dbPassword}`,
    `POSTGRES_DB=${dbName}`,
    "DATABASE_HOST=dawarich_db",
    "DATABASE_PORT=5432",
    "DATABASE_USERNAME=postgres",
    `DATABASE_PASSWORD=${dbPassword}`,
    `DATABASE_NAME=${dbName}`,
    "REDIS_URL=redis://dawarich_redis:6379",
    `APPLICATION_HOSTS=${appHosts}`,
    `APPLICATION_PROTOCOL=${appProtocol}`,
    `TIME_ZONE=${tz}`,
    `SECRET_KEY_BASE=${secretKeyBase}`,
    "SELF_HOSTED=true",
    `STORE_GEODATA=${geodata}`,
    "PROMETHEUS_EXPORTER_ENABLED=false",
    "RAILS_LOG_TO_STDOUT=true",
    "BACKGROUND_PROCESSING_CONCURRENCY=10",
    "LOG_MAX_SIZE=100m",
    "LOG_MAX_FILE=5",
    `APP_CPU_LIMIT=${cpuLimit}`,
    `APP_MEMORY_LIMIT=${memLimit}`,
  ];

  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `networks:
  dawarich:

services:
  dawarich_redis:
    image: redis:\${REDIS_IMAGE_TAG}
    container_name: dawarich_redis
    command: >
      redis-server
      --save 900 1
      --save 300 10
      --appendonly no
    networks:
      - dawarich
    volumes:
      - dawarich_shared:/data
    restart: always
    healthcheck:
      test: [ "CMD", "redis-cli", "--raw", "incr", "ping" ]
      interval: 10s
      retries: 5
      start_period: 30s
      timeout: 10s

  dawarich_db:
    image: postgis/postgis:\${POSTGIS_IMAGE_TAG}
    shm_size: 1G
    container_name: dawarich_db
    volumes:
      - dawarich_db_data:/var/lib/postgresql/data
      - dawarich_shared:/var/shared
    networks:
      - dawarich
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    restart: always
    healthcheck:
      test: [ "CMD-SHELL", "pg_isready -U postgres -d \${POSTGRES_DB}" ]
      interval: 10s
      retries: 5
      start_period: 30s
      timeout: 10s

  dawarich_app:
    image: freikin/dawarich:\${DAWARICH_IMAGE_TAG}
    container_name: dawarich_app
    volumes:
      - dawarich_public:/var/app/public
      - dawarich_watched:/var/app/tmp/imports/watched
      - dawarich_storage:/var/app/storage
      - dawarich_db_data:/dawarich_db_data
    networks:
      - dawarich
    ports:
      - "\${DAWARICH_APP_PORT:-3000}:3000"
    stdin_open: true
    tty: true
    entrypoint: web-entrypoint.sh
    command: ['bin/rails', 'server', '-p', '3000', '-b', '::']
    restart: on-failure
    env_file:
      - .env
    healthcheck:
      test: [ "CMD-SHELL", "wget -qO - http://127.0.0.1:3000/api/v1/health | grep -q '\"status\"\\s*:\\s*\"ok\"'" ]
      interval: 10s
      retries: 30
      start_period: 30s
      timeout: 10s
    depends_on:
      dawarich_db:
        condition: service_healthy
        restart: true
      dawarich_redis:
        condition: service_healthy
        restart: true
    deploy:
      resources:
        limits:
          cpus: \${APP_CPU_LIMIT:-0.50}
          memory: \${APP_MEMORY_LIMIT:-4G}

  dawarich_sidekiq:
    image: freikin/dawarich:\${DAWARICH_IMAGE_TAG}
    container_name: dawarich_sidekiq
    volumes:
      - dawarich_public:/var/app/public
      - dawarich_watched:/var/app/tmp/imports/watched
      - dawarich_storage:/var/app/storage
    networks:
      - dawarich
    stdin_open: true
    tty: true
    entrypoint: sidekiq-entrypoint.sh
    command: ['sidekiq']
    restart: on-failure
    env_file:
      - .env
    healthcheck:
      test: [ "CMD-SHELL", "pgrep -f sidekiq" ]
      interval: 10s
      retries: 30
      start_period: 30s
      timeout: 10s
    depends_on:
      dawarich_db:
        condition: service_healthy
        restart: true
      dawarich_redis:
        condition: service_healthy
        restart: true
      dawarich_app:
        condition: service_healthy
        restart: true

volumes:
  dawarich_db_data:
  dawarich_shared:
  dawarich_public:
  dawarich_watched:
  dawarich_storage:
`;
}

/**
 * @param {Record<string, unknown>} dawarich
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(dawarich, ctIp = null) {
  const parsed = parsePublicUrl(dawarich);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(dawarich);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} dawarich
 */
export function resolveUpstreamUrl(ctIp, dawarich) {
  const port = hostPort(dawarich);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
