import { listmonkMailEnvLines } from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} listmonk
 */
export function normalizeImageTag(listmonk) {
  const t = typeof listmonk.image_tag === "string" ? listmonk.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} listmonk
 */
export function normalizePostgresImageTag(listmonk) {
  const t =
    typeof listmonk.postgres_image_tag === "string" ? listmonk.postgres_image_tag.trim() : "";
  if (!t) return "17-alpine";
  return t;
}

/**
 * @param {Record<string, unknown>} listmonk
 */
export function hostPort(listmonk) {
  const p = typeof listmonk.host_port === "number" ? listmonk.host_port : Number(listmonk.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 9000;
}

/**
 * @param {Record<string, unknown>} listmonk
 */
export function normalizeTimezone(listmonk) {
  const tz = typeof listmonk.timezone === "string" ? listmonk.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} listmonk
 */
export function normalizeAdminUser(listmonk) {
  const u = typeof listmonk.admin_user === "string" ? listmonk.admin_user.trim() : "";
  return u || "admin";
}

/**
 * @param {Record<string, unknown>} listmonk
 */
export function adminPasswordVaultKey(listmonk) {
  const key =
    typeof listmonk.admin_password_vault_key === "string" && listmonk.admin_password_vault_key.trim()
      ? listmonk.admin_password_vault_key.trim()
      : "HDC_LISTMONK_ADMIN_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} listmonk
 */
export function dbPasswordVaultKey(listmonk) {
  const key =
    typeof listmonk.db_password_vault_key === "string" && listmonk.db_password_vault_key.trim()
      ? listmonk.db_password_vault_key.trim()
      : "HDC_LISTMONK_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} listmonk
 * @returns {URL | null}
 */
export function parsePublicUrl(listmonk) {
  const raw = typeof listmonk.public_url === "string" ? listmonk.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`listmonk.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("listmonk.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} listmonk
 * @param {string | null} [ctIp]
 */
export function resolveHostname(listmonk, ctIp = null) {
  const parsed = parsePublicUrl(listmonk);
  if (parsed) return parsed.hostname;
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  return ip || "listmonk.local";
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/listmonk";
}

/**
 * @param {Record<string, unknown>} listmonk
 * @param {{ adminPassword: string; dbPassword: string }} secrets
 * @param {string | null} [ctIp]
 */
export function renderListmonkEnv(listmonk, secrets, ctIp = null) {
  const tag = normalizeImageTag(listmonk);
  const pgTag = normalizePostgresImageTag(listmonk);
  const port = hostPort(listmonk);
  const tz = normalizeTimezone(listmonk);
  const adminUser = normalizeAdminUser(listmonk);
  const adminPassword = String(secrets.adminPassword || "").trim();
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!adminPassword) {
    throw new Error("LISTMONK_ADMIN_PASSWORD is required");
  }
  if (!dbPassword) {
    throw new Error("LISTMONK DB password is required");
  }

  const dbUser = "listmonk";
  const dbName = "listmonk";
  const hostname = resolveHostname(listmonk, ctIp);
  const parsed = parsePublicUrl(listmonk);

  const lines = [
    "# hdc-generated — docker compose",
    `LISTMONK_IMAGE_TAG=${tag}`,
    `POSTGRES_IMAGE_TAG=${pgTag}`,
    `LISTMONK_HOST_PORT=${port}`,
    `LISTMONK_HOSTNAME=${hostname}`,
    `POSTGRES_USER=${dbUser}`,
    `POSTGRES_PASSWORD=${dbPassword}`,
    `POSTGRES_DB=${dbName}`,
    "LISTMONK_app__address=0.0.0.0:9000",
    `LISTMONK_db__user=${dbUser}`,
    `LISTMONK_db__password=${dbPassword}`,
    `LISTMONK_db__database=${dbName}`,
    "LISTMONK_db__host=db",
    "LISTMONK_db__port=5432",
    "LISTMONK_db__ssl_mode=disable",
    "LISTMONK_db__max_open=25",
    "LISTMONK_db__max_idle=25",
    "LISTMONK_db__max_lifetime=300s",
    `TZ=${tz}`,
    `LISTMONK_ADMIN_USER=${adminUser}`,
    `LISTMONK_ADMIN_PASSWORD=${adminPassword}`,
  ];

  if (parsed) {
    const rootUrl = parsed.origin.replace(/\/+$/, "");
    lines.push(`LISTMONK_app__root_url=${rootUrl}`);
  }

  for (const line of listmonkMailEnvLines(listmonk)) {
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  app:
    image: listmonk/listmonk:\${LISTMONK_IMAGE_TAG}
    container_name: listmonk_app
    restart: unless-stopped
    ports:
      - "\${LISTMONK_HOST_PORT}:9000"
    networks:
      - listmonk
    hostname: \${LISTMONK_HOSTNAME}
    depends_on:
      - db
    command: [sh, -c, "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''"]
    env_file:
      - .env
    volumes:
      - ./uploads:/listmonk/uploads:rw

  db:
    image: postgres:\${POSTGRES_IMAGE_TAG}
    container_name: listmonk_db
    restart: unless-stopped
    ports:
      - "127.0.0.1:5432:5432"
    networks:
      - listmonk
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U listmonk"]
      interval: 10s
      timeout: 5s
      retries: 6
    volumes:
      - listmonk-data:/var/lib/postgresql/data

networks:
  listmonk:

volumes:
  listmonk-data:
`;
}

/**
 * @param {Record<string, unknown>} listmonk
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(listmonk, ctIp = null) {
  const parsed = parsePublicUrl(listmonk);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(listmonk);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} listmonk
 */
export function resolveUpstreamUrl(ctIp, listmonk) {
  const port = hostPort(listmonk);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
