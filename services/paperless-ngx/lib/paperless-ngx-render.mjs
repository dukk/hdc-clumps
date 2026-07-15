/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeImageTag(cfg) {
  const t = typeof cfg.image_tag === "string" ? cfg.image_tag.trim() : "";
  return t || "latest";
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizePostgresImageTag(cfg) {
  const t = typeof cfg.postgres_image_tag === "string" ? cfg.postgres_image_tag.trim() : "";
  return t || "18";
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeRedisImageTag(cfg) {
  const t = typeof cfg.redis_image_tag === "string" ? cfg.redis_image_tag.trim() : "";
  return t || "8";
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeGotenbergImageTag(cfg) {
  const t = typeof cfg.gotenberg_image_tag === "string" ? cfg.gotenberg_image_tag.trim() : "";
  return t || "8.25";
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeTikaImageTag(cfg) {
  const t = typeof cfg.tika_image_tag === "string" ? cfg.tika_image_tag.trim() : "";
  return t || "latest";
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function hostPort(cfg) {
  const p = typeof cfg.host_port === "number" ? cfg.host_port : Number(cfg.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8000;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function tikaEnabled(cfg) {
  if (cfg.tika_enabled === false) return false;
  return true;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeTimezone(cfg) {
  const tz = typeof cfg.timezone === "string" ? cfg.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeOcrLanguage(cfg) {
  const lang = typeof cfg.ocr_language === "string" ? cfg.ocr_language.trim() : "";
  return lang || "eng";
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function webserverWorkers(cfg) {
  const w =
    typeof cfg.webserver_workers === "number" ? cfg.webserver_workers : Number(cfg.webserver_workers);
  if (Number.isFinite(w) && w >= 1 && w <= 32) return Math.floor(w);
  return 2;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function usermapUid(cfg) {
  const u = typeof cfg.usermap_uid === "number" ? cfg.usermap_uid : Number(cfg.usermap_uid);
  if (Number.isFinite(u) && u >= 0) return Math.floor(u);
  return 1000;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function usermapGid(cfg) {
  const g = typeof cfg.usermap_gid === "number" ? cfg.usermap_gid : Number(cfg.usermap_gid);
  if (Number.isFinite(g) && g >= 0) return Math.floor(g);
  return 1000;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function secretKeyVaultKey(cfg) {
  const key =
    typeof cfg.secret_key_vault_key === "string" && cfg.secret_key_vault_key.trim()
      ? cfg.secret_key_vault_key.trim()
      : "HDC_PAPERLESS_SECRET_KEY";
  return key;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function dbPasswordVaultKey(cfg) {
  const key =
    typeof cfg.db_password_vault_key === "string" && cfg.db_password_vault_key.trim()
      ? cfg.db_password_vault_key.trim()
      : "HDC_PAPERLESS_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function adminPasswordVaultKey(cfg) {
  const admin = isObject(cfg.admin) ? cfg.admin : {};
  const key =
    typeof admin.password_vault_key === "string" && admin.password_vault_key.trim()
      ? admin.password_vault_key.trim()
      : "HDC_PAPERLESS_ADMIN_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function adminBootstrapEnabled(cfg) {
  const admin = isObject(cfg.admin) ? cfg.admin : {};
  return admin.enabled === true;
}

/**
 * @param {Record<string, unknown>} cfg
 * @returns {URL | null}
 */
export function parsePublicUrl(cfg) {
  const raw = typeof cfg.public_url === "string" ? cfg.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`paperless_ngx.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("paperless_ngx.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string | null} [ctIp]
 */
export function formatPaperlessUrl(cfg, ctIp = null) {
  const parsed = parsePublicUrl(cfg);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(cfg);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/paperless-ngx";
}

const DB_USER = "paperless";
const DB_NAME = "paperless";

/**
 * Docker Compose variable substitution (.env).
 * @param {Record<string, unknown>} cfg
 * @param {{ dbPassword: string }} secrets
 */
export function renderDotEnv(cfg, secrets) {
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!dbPassword) {
    throw new Error("Paperless DB password is required");
  }
  const port = hostPort(cfg);
  const lines = [
    "# hdc-generated — docker compose",
    `PAPERLESS_IMAGE_TAG=${normalizeImageTag(cfg)}`,
    `POSTGRES_IMAGE_TAG=${normalizePostgresImageTag(cfg)}`,
    `REDIS_IMAGE_TAG=${normalizeRedisImageTag(cfg)}`,
    `GOTENBERG_IMAGE_TAG=${normalizeGotenbergImageTag(cfg)}`,
    `TIKA_IMAGE_TAG=${normalizeTikaImageTag(cfg)}`,
    `PAPERLESS_HOST_PORT=${port}`,
    `POSTGRES_USER=${DB_USER}`,
    `POSTGRES_PASSWORD=${dbPassword}`,
    `POSTGRES_DB=${DB_NAME}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Paperless webserver env_file (upstream docker-compose.env shape).
 * @param {Record<string, unknown>} cfg
 * @param {{ secretKey: string; dbPassword: string; adminPassword?: string | null }} secrets
 * @param {string | null} [ctIp]
 */
export function renderPaperlessEnv(cfg, secrets, ctIp = null) {
  const secretKey = String(secrets.secretKey || "").trim();
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!secretKey) {
    throw new Error("PAPERLESS_SECRET_KEY is required");
  }
  if (!dbPassword) {
    throw new Error("Paperless DB password is required");
  }

  const tz = normalizeTimezone(cfg);
  const ocrLang = normalizeOcrLanguage(cfg);
  const workers = webserverWorkers(cfg);
  const uid = usermapUid(cfg);
  const gid = usermapGid(cfg);
  const paperlessUrl = formatPaperlessUrl(cfg, ctIp);

  const lines = [
    "# hdc-generated — paperless webserver env_file",
    `USERMAP_UID=${uid}`,
    `USERMAP_GID=${gid}`,
    `PAPERLESS_SECRET_KEY=${secretKey}`,
    `PAPERLESS_DBPASS=${dbPassword}`,
    `PAPERLESS_DBUSER=${DB_USER}`,
    `PAPERLESS_DBNAME=${DB_NAME}`,
    `PAPERLESS_TIME_ZONE=${tz}`,
    `PAPERLESS_OCR_LANGUAGE=${ocrLang}`,
    `PAPERLESS_WEBSERVER_WORKERS=${workers}`,
  ];

  if (paperlessUrl) {
    lines.push(`PAPERLESS_URL=${paperlessUrl}`);
  }

  if (adminBootstrapEnabled(cfg)) {
    const admin = isObject(cfg.admin) ? cfg.admin : {};
    const user = typeof admin.user === "string" && admin.user.trim() ? admin.user.trim() : "admin";
    const mail =
      typeof admin.mail === "string" && admin.mail.trim()
        ? admin.mail.trim()
        : "admin@hdc.example.invalid";
    const adminPassword = String(secrets.adminPassword || "").trim();
    if (!adminPassword) {
      throw new Error("PAPERLESS_ADMIN_PASSWORD is required when paperless_ngx.admin.enabled is true");
    }
    lines.push(`PAPERLESS_ADMIN_USER=${user}`);
    lines.push(`PAPERLESS_ADMIN_PASSWORD=${adminPassword}`);
    lines.push(`PAPERLESS_ADMIN_MAIL=${mail}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {{ tikaEnabled?: boolean }} [opts]
 */
/**
 * @param {string} tag
 */
function postgresDataMountPath(tag) {
  const major = Number.parseInt(String(tag).replace(/^[^0-9]*/, ""), 10);
  if (Number.isFinite(major) && major >= 18) {
    return "/var/lib/postgresql";
  }
  return "/var/lib/postgresql/data";
}

export function renderComposeYaml(opts = {}) {
  const withTika = opts.tikaEnabled !== false;
  const postgresTag = opts.postgresImageTag ?? "18";
  const pgDataMount = postgresDataMountPath(postgresTag);

  const webDepends = withTika
    ? `    depends_on:
      - db
      - broker
      - gotenberg
      - tika`
    : `    depends_on:
      - db
      - broker`;

  const tikaServices = withTika
    ? `
  gotenberg:
    image: docker.io/gotenberg/gotenberg:\${GOTENBERG_IMAGE_TAG}
    restart: unless-stopped
    command:
      - "gotenberg"
      - "--chromium-disable-javascript=true"
      - "--chromium-allow-list=file:///tmp/.*"

  tika:
    image: docker.io/apache/tika:\${TIKA_IMAGE_TAG}
    restart: unless-stopped`
    : "";

  const tikaEnv = withTika
    ? `
      PAPERLESS_TIKA_ENABLED: 1
      PAPERLESS_TIKA_GOTENBERG_ENDPOINT: http://gotenberg:3000
      PAPERLESS_TIKA_ENDPOINT: http://tika:9998`
    : "";

  return `services:
  broker:
    image: docker.io/library/redis:\${REDIS_IMAGE_TAG}
    restart: unless-stopped
    volumes:
      - redisdata:/data

  db:
    image: docker.io/library/postgres:\${POSTGRES_IMAGE_TAG}
    restart: unless-stopped
    volumes:
      - pgdata:${pgDataMount}
    environment:
      POSTGRES_DB: \${POSTGRES_DB}
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h localhost -U $$POSTGRES_USER"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 30s
${tikaServices}

  webserver:
    image: ghcr.io/paperless-ngx/paperless-ngx:\${PAPERLESS_IMAGE_TAG}
    restart: unless-stopped
${webDepends}
    ports:
      - "\${PAPERLESS_HOST_PORT}:8000"
    volumes:
      - data:/usr/src/paperless/data
      - media:/usr/src/paperless/media
      - ./export:/usr/src/paperless/export
      - ./consume:/usr/src/paperless/consume
    env_file: paperless.env
    environment:
      PAPERLESS_REDIS: redis://broker:6379
      PAPERLESS_DBHOST: db${tikaEnv}

volumes:
  data:
  media:
  pgdata:
  redisdata:
`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} cfg
 */
export function resolveUpstreamUrl(ctIp, cfg) {
  const port = hostPort(cfg);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(cfg, ctIp = null) {
  const parsed = parsePublicUrl(cfg);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(cfg);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}
