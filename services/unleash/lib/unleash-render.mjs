/**
 * @param {Record<string, unknown>} unleash
 */
export function normalizeImageTag(unleash) {
  const t = typeof unleash.image_tag === "string" ? unleash.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} unleash
 */
export function normalizePostgresImageTag(unleash) {
  const t =
    typeof unleash.postgres_image_tag === "string" ? unleash.postgres_image_tag.trim() : "";
  if (!t) return "17-alpine";
  return t;
}

/**
 * @param {Record<string, unknown>} unleash
 */
export function hostPort(unleash) {
  const p = typeof unleash.host_port === "number" ? unleash.host_port : Number(unleash.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 4242;
}

/**
 * @param {Record<string, unknown>} unleash
 */
export function normalizeAdminUser(unleash) {
  const u = typeof unleash.admin_user === "string" ? unleash.admin_user.trim() : "";
  return u || "admin";
}

/**
 * @param {Record<string, unknown>} unleash
 */
export function normalizeLogLevel(unleash) {
  const l = typeof unleash.log_level === "string" ? unleash.log_level.trim() : "";
  return l || "warn";
}

/**
 * @param {Record<string, unknown>} unleash
 */
export function adminPasswordVaultKey(unleash) {
  const key =
    typeof unleash.admin_password_vault_key === "string" && unleash.admin_password_vault_key.trim()
      ? unleash.admin_password_vault_key.trim()
      : "HDC_UNLEASH_ADMIN_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} unleash
 */
export function dbPasswordVaultKey(unleash) {
  const key =
    typeof unleash.db_password_vault_key === "string" && unleash.db_password_vault_key.trim()
      ? unleash.db_password_vault_key.trim()
      : "HDC_UNLEASH_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} unleash
 * @returns {URL | null}
 */
export function parsePublicUrl(unleash) {
  const raw = typeof unleash.public_url === "string" ? unleash.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`unleash.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("unleash.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/unleash";
}

/**
 * @param {Record<string, unknown>} unleash
 * @param {{ adminPassword: string; dbPassword: string }} secrets
 */
export function renderUnleashEnv(unleash, secrets) {
  const tag = normalizeImageTag(unleash);
  const pgTag = normalizePostgresImageTag(unleash);
  const port = hostPort(unleash);
  const adminUser = normalizeAdminUser(unleash);
  const logLevel = normalizeLogLevel(unleash);
  const adminPassword = String(secrets.adminPassword || "").trim();
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!adminPassword) {
    throw new Error("UNLEASH_ADMIN_PASSWORD is required");
  }
  if (!dbPassword) {
    throw new Error("UNLEASH DB password is required");
  }

  const dbUser = "unleash";
  const dbName = "unleash";
  const parsed = parsePublicUrl(unleash);

  const lines = [
    "# hdc-generated — docker compose",
    `UNLEASH_IMAGE_TAG=${tag}`,
    `POSTGRES_IMAGE_TAG=${pgTag}`,
    `UNLEASH_HOST_PORT=${port}`,
    `POSTGRES_USER=${dbUser}`,
    `POSTGRES_PASSWORD=${dbPassword}`,
    `POSTGRES_DB=${dbName}`,
    `DATABASE_URL=postgres://${dbUser}:${encodeURIComponent(dbPassword)}@db:5432/${dbName}?sslmode=disable`,
    "DATABASE_SSL=false",
    `UNLEASH_DEFAULT_ADMIN_USERNAME=${adminUser}`,
    `UNLEASH_DEFAULT_ADMIN_PASSWORD=${adminPassword}`,
    `LOG_LEVEL=${logLevel}`,
  ];

  if (parsed) {
    const rootUrl = parsed.origin.replace(/\/+$/, "");
    lines.push(`UNLEASH_URL=${rootUrl}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  web:
    image: unleashorg/unleash-server:\${UNLEASH_IMAGE_TAG}
    container_name: unleash_web
    restart: unless-stopped
    ports:
      - "\${UNLEASH_HOST_PORT}:4242"
    networks:
      - unleash
    env_file:
      - .env
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: wget --no-verbose --tries=1 --spider http://localhost:4242/health || exit 1
      interval: 10s
      timeout: 1m
      retries: 5
      start_period: 15s

  db:
    image: postgres:\${POSTGRES_IMAGE_TAG}
    container_name: unleash_db
    restart: unless-stopped
    networks:
      - unleash
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    healthcheck:
      test: ["CMD", "pg_isready", "--username=unleash", "--host=127.0.0.1", "--port=5432"]
      interval: 10s
      timeout: 5s
      retries: 6
    volumes:
      - unleash-data:/var/lib/postgresql/data

networks:
  unleash:

volumes:
  unleash-data:
`;
}

/**
 * @param {Record<string, unknown>} unleash
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(unleash, ctIp = null) {
  const parsed = parsePublicUrl(unleash);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(unleash);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} unleash
 */
export function resolveUpstreamUrl(ctIp, unleash) {
  const port = hostPort(unleash);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
