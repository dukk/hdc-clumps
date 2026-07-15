import { wallabagMailEnvLines } from "hdc/package/app-mail-render.mjs";

/**
 * @param {Record<string, unknown>} wallabag
 */
export function normalizeImageTag(wallabag) {
  const t = typeof wallabag.image_tag === "string" ? wallabag.image_tag.trim() : "";
  return t || "latest";
}

/**
 * @param {Record<string, unknown>} wallabag
 */
export function normalizeMariadbImageTag(wallabag) {
  const t =
    typeof wallabag.mariadb_image_tag === "string" ? wallabag.mariadb_image_tag.trim() : "";
  return t || "11";
}

/**
 * @param {Record<string, unknown>} wallabag
 */
export function normalizeRedisImageTag(wallabag) {
  const t = typeof wallabag.redis_image_tag === "string" ? wallabag.redis_image_tag.trim() : "";
  return t || "7-alpine";
}

/**
 * @param {Record<string, unknown>} wallabag
 */
export function hostPort(wallabag) {
  const p = typeof wallabag.host_port === "number" ? wallabag.host_port : Number(wallabag.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 80;
}

/**
 * @param {Record<string, unknown>} wallabag
 */
export function normalizeTimezone(wallabag) {
  const tz = typeof wallabag.timezone === "string" ? wallabag.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} wallabag
 */
export function normalizeServerName(wallabag) {
  const n = typeof wallabag.server_name === "string" ? wallabag.server_name.trim() : "";
  return n || "Wallabag";
}

/**
 * @param {Record<string, unknown>} wallabag
 */
export function dbPasswordVaultKey(wallabag) {
  const key =
    typeof wallabag.db_password_vault_key === "string" && wallabag.db_password_vault_key.trim()
      ? wallabag.db_password_vault_key.trim()
      : "HDC_WALLABAG_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} wallabag
 */
export function secretVaultKey(wallabag) {
  const key =
    typeof wallabag.secret_vault_key === "string" && wallabag.secret_vault_key.trim()
      ? wallabag.secret_vault_key.trim()
      : "HDC_WALLABAG_SECRET";
  return key;
}

/**
 * @param {Record<string, unknown>} wallabag
 * @returns {URL | null}
 */
export function parsePublicUrl(wallabag) {
  const raw = typeof wallabag.public_url === "string" ? wallabag.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`wallabag.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("wallabag.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/wallabag";
}

/**
 * @param {Record<string, unknown>} wallabag
 * @param {string | null} [ctIp]
 */
export function resolveDomainName(wallabag, ctIp = null) {
  const parsed = parsePublicUrl(wallabag);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(wallabag);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) {
    if (port === 80) return `http://${ip}`;
    return `http://${ip}:${port}`;
  }
  throw new Error("wallabag.public_url is required when CT IP is unknown");
}

/**
 * @param {Record<string, unknown>} wallabag
 * @param {{ dbPassword: string; secret: string }} secrets
 * @param {string | null} [ctIp]
 */
export function renderWallabagEnv(wallabag, secrets, ctIp = null) {
  const tag = normalizeImageTag(wallabag);
  const mariaTag = normalizeMariadbImageTag(wallabag);
  const redisTag = normalizeRedisImageTag(wallabag);
  const port = hostPort(wallabag);
  const tz = normalizeTimezone(wallabag);
  const serverName = normalizeServerName(wallabag);
  const domainName = resolveDomainName(wallabag, ctIp);
  const dbPassword = String(secrets.dbPassword || "").trim();
  const secret = String(secrets.secret || "").trim();
  if (!dbPassword) throw new Error("Wallabag DB password is required");
  if (!secret) throw new Error("Wallabag Symfony secret is required");

  const dbUser = "wallabag";
  const dbName = "wallabag";

  /** @type {string[]} */
  /** @type {string[]} */
  const lines = [
    "# hdc-generated — docker compose",
    `WALLABAG_IMAGE_TAG=${tag}`,
    `MARIADB_IMAGE_TAG=${mariaTag}`,
    `REDIS_IMAGE_TAG=${redisTag}`,
    `WALLABAG_HOST_PORT=${port}`,
    `MYSQL_ROOT_PASSWORD=${dbPassword}`,
    `SYMFONY__ENV__DATABASE_DRIVER=pdo_mysql`,
    `SYMFONY__ENV__DATABASE_HOST=db`,
    `SYMFONY__ENV__DATABASE_PORT=3306`,
    `SYMFONY__ENV__DATABASE_NAME=${dbName}`,
    `SYMFONY__ENV__DATABASE_USER=${dbUser}`,
    `SYMFONY__ENV__DATABASE_PASSWORD=${dbPassword}`,
    `SYMFONY__ENV__DATABASE_CHARSET=utf8mb4`,
    `SYMFONY__ENV__DATABASE_TABLE_PREFIX=wallabag_`,
    `SYMFONY__ENV__SECRET=${secret}`,
    `SYMFONY__ENV__DOMAIN_NAME=${domainName}`,
    `SYMFONY__ENV__SERVER_NAME=${serverName}`,
    `SYMFONY__ENV__REDIS_HOST=redis`,
    `SYMFONY__ENV__REDIS_PORT=6379`,
    `SYMFONY__ENV__REDIS_SCHEME=tcp`,
    `TZ=${tz}`,
    `POPULATE_DATABASE=true`,
  ];

  const mailLines = wallabagMailEnvLines(wallabag);
  if (mailLines.length) {
    lines.push(...mailLines);
  } else {
    lines.push("SYMFONY__ENV__MAILER_DSN=smtp://127.0.0.1");
    lines.push("SYMFONY__ENV__FROM_EMAIL=wallabag@localhost");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} wallabag
 */
export function renderComposeYaml(wallabag) {
  void wallabag;
  return `services:
  wallabag:
    image: wallabag/wallabag:\${WALLABAG_IMAGE_TAG}
    container_name: wallabag_app
    restart: unless-stopped
    ports:
      - "\${WALLABAG_HOST_PORT}:80"
    networks:
      - wallabag
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    env_file:
      - .env
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
      SYMFONY__ENV__DATABASE_DRIVER: \${SYMFONY__ENV__DATABASE_DRIVER}
      SYMFONY__ENV__DATABASE_HOST: \${SYMFONY__ENV__DATABASE_HOST}
      SYMFONY__ENV__DATABASE_PORT: \${SYMFONY__ENV__DATABASE_PORT}
      SYMFONY__ENV__DATABASE_NAME: \${SYMFONY__ENV__DATABASE_NAME}
      SYMFONY__ENV__DATABASE_USER: \${SYMFONY__ENV__DATABASE_USER}
      SYMFONY__ENV__DATABASE_PASSWORD: \${SYMFONY__ENV__DATABASE_PASSWORD}
      SYMFONY__ENV__DATABASE_CHARSET: \${SYMFONY__ENV__DATABASE_CHARSET}
      SYMFONY__ENV__DATABASE_TABLE_PREFIX: \${SYMFONY__ENV__DATABASE_TABLE_PREFIX}
      SYMFONY__ENV__SECRET: \${SYMFONY__ENV__SECRET}
      SYMFONY__ENV__DOMAIN_NAME: \${SYMFONY__ENV__DOMAIN_NAME}
      SYMFONY__ENV__SERVER_NAME: \${SYMFONY__ENV__SERVER_NAME}
      SYMFONY__ENV__REDIS_HOST: \${SYMFONY__ENV__REDIS_HOST}
      SYMFONY__ENV__REDIS_PORT: \${SYMFONY__ENV__REDIS_PORT}
      SYMFONY__ENV__REDIS_SCHEME: \${SYMFONY__ENV__REDIS_SCHEME}
      SYMFONY__ENV__MAILER_DSN: \${SYMFONY__ENV__MAILER_DSN:-smtp://127.0.0.1}
      SYMFONY__ENV__FROM_EMAIL: \${SYMFONY__ENV__FROM_EMAIL:-wallabag@localhost}
      POPULATE_DATABASE: \${POPULATE_DATABASE}
      TZ: \${TZ}
    volumes:
      - wallabag-images:/var/www/wallabag/web/assets/images
      - wallabag-data:/var/www/wallabag/data

  db:
    image: mariadb:\${MARIADB_IMAGE_TAG}
    container_name: wallabag_db
    restart: unless-stopped
    networks:
      - wallabag
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 20s
      timeout: 5s
      retries: 10
    volumes:
      - wallabag-db-data:/var/lib/mysql

  redis:
    image: redis:\${REDIS_IMAGE_TAG}
    container_name: wallabag_redis
    restart: unless-stopped
    networks:
      - wallabag
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 20s
      timeout: 3s
      retries: 5
    volumes:
      - wallabag-redis-data:/data

networks:
  wallabag:

volumes:
  wallabag-images:
  wallabag-data:
  wallabag-db-data:
  wallabag-redis-data:
`;
}

/**
 * @param {Record<string, unknown>} wallabag
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(wallabag, ctIp = null) {
  const parsed = parsePublicUrl(wallabag);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(wallabag);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  if (port === 80) return `http://${ip}`;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} wallabag
 */
export function resolveUpstreamUrl(ctIp, wallabag) {
  const port = hostPort(wallabag);
  if (!ctIp) return null;
  return `http://${ctIp}:${port}`;
}
