import { vikunjaMailEnvLines } from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} vikunja
 */
export function normalizeImageTag(vikunja) {
  const t = typeof vikunja.image_tag === "string" ? vikunja.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} vikunja
 */
export function normalizePostgresImageTag(vikunja) {
  const t =
    typeof vikunja.postgres_image_tag === "string" ? vikunja.postgres_image_tag.trim() : "";
  if (!t) return "16-alpine";
  return t;
}

/**
 * @param {Record<string, unknown>} vikunja
 */
export function hostPort(vikunja) {
  const p = typeof vikunja.host_port === "number" ? vikunja.host_port : Number(vikunja.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3456;
}

/**
 * @param {Record<string, unknown>} vikunja
 */
export function normalizeTimezone(vikunja) {
  const tz = typeof vikunja.timezone === "string" ? vikunja.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} vikunja
 */
export function jwtSecretVaultKey(vikunja) {
  const key =
    typeof vikunja.jwt_secret_vault_key === "string" && vikunja.jwt_secret_vault_key.trim()
      ? vikunja.jwt_secret_vault_key.trim()
      : "HDC_VIKUNJA_JWT_SECRET";
  return key;
}

/**
 * @param {Record<string, unknown>} vikunja
 */
export function dbPasswordVaultKey(vikunja) {
  const key =
    typeof vikunja.db_password_vault_key === "string" && vikunja.db_password_vault_key.trim()
      ? vikunja.db_password_vault_key.trim()
      : "HDC_VIKUNJA_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} vikunja
 * @returns {URL | null}
 */
export function parsePublicUrl(vikunja) {
  const raw = typeof vikunja.public_url === "string" ? vikunja.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`vikunja.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("vikunja.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * Vikunja requires VIKUNJA_SERVICE_PUBLICURL with a trailing slash.
 * @param {Record<string, unknown>} vikunja
 * @param {string | null} [ctIp]
 */
export function formatVikunjaPublicUrl(vikunja, ctIp = null) {
  const parsed = parsePublicUrl(vikunja);
  if (parsed) {
    const base = parsed.origin.replace(/\/+$/, "");
    return `${base}/`;
  }
  const port = hostPort(vikunja);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}/`;
  throw new Error("vikunja.public_url is required when CT IP is unknown");
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/vikunja";
}

/**
 * @param {Record<string, unknown>} vikunja
 * @param {{ jwtSecret: string; dbPassword: string }} secrets
 * @param {string | null} [ctIp]
 */
export function renderVikunjaEnv(vikunja, secrets, ctIp = null) {
  const tag = normalizeImageTag(vikunja);
  const pgTag = normalizePostgresImageTag(vikunja);
  const port = hostPort(vikunja);
  const tz = normalizeTimezone(vikunja);
  const jwtSecret = String(secrets.jwtSecret || "").trim();
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!jwtSecret) {
    throw new Error("VIKUNJA JWT secret is required");
  }
  if (!dbPassword) {
    throw new Error("VIKUNJA DB password is required");
  }

  const dbUser = "vikunja";
  const dbName = "vikunja";
  const publicUrl = formatVikunjaPublicUrl(vikunja, ctIp);

  const lines = [
    "# hdc-generated — docker compose",
    `VIKUNJA_IMAGE_TAG=${tag}`,
    `POSTGRES_IMAGE_TAG=${pgTag}`,
    `VIKUNJA_HOST_PORT=${port}`,
    `POSTGRES_USER=${dbUser}`,
    `POSTGRES_PASSWORD=${dbPassword}`,
    `POSTGRES_DB=${dbName}`,
    `VIKUNJA_SERVICE_PUBLICURL=${publicUrl}`,
    `VIKUNJA_SERVICE_JWTSECRET=${jwtSecret}`,
    "VIKUNJA_DATABASE_TYPE=postgres",
    "VIKUNJA_DATABASE_HOST=db",
    `VIKUNJA_DATABASE_USER=${dbUser}`,
    `VIKUNJA_DATABASE_PASSWORD=${dbPassword}`,
    `VIKUNJA_DATABASE_DATABASE=${dbName}`,
    `TZ=${tz}`,
  ];

  for (const line of vikunjaMailEnvLines(vikunja)) {
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  vikunja:
    image: vikunja/vikunja:\${VIKUNJA_IMAGE_TAG}
    container_name: vikunja_app
    restart: unless-stopped
    ports:
      - "\${VIKUNJA_HOST_PORT}:3456"
    env_file:
      - .env
    volumes:
      - ./files:/app/vikunja/files
    depends_on:
      db:
        condition: service_healthy
    networks:
      - vikunja

  db:
    image: postgres:\${POSTGRES_IMAGE_TAG}
    container_name: vikunja_db
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h localhost -U $$POSTGRES_USER"]
      interval: 2s
      timeout: 5s
      retries: 10
      start_period: 30s
    volumes:
      - vikunja-db-data:/var/lib/postgresql/data
    networks:
      - vikunja

networks:
  vikunja:

volumes:
  vikunja-db-data:
`;
}

/**
 * @param {Record<string, unknown>} vikunja
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(vikunja, ctIp = null) {
  const parsed = parsePublicUrl(vikunja);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(vikunja);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} vikunja
 */
export function resolveUpstreamUrl(ctIp, vikunja) {
  const port = hostPort(vikunja);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
