import { docusealMailEnvLines } from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} docuseal
 */
export function normalizeImageTag(docuseal) {
  const t = typeof docuseal.image_tag === "string" ? docuseal.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} docuseal
 */
export function normalizePostgresImageTag(docuseal) {
  const t =
    typeof docuseal.postgres_image_tag === "string" ? docuseal.postgres_image_tag.trim() : "";
  if (!t) return "16";
  return t;
}

/**
 * @param {Record<string, unknown>} docuseal
 */
export function hostPort(docuseal) {
  const p = typeof docuseal.host_port === "number" ? docuseal.host_port : Number(docuseal.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3000;
}

/**
 * @param {Record<string, unknown>} docuseal
 */
export function normalizeTimezone(docuseal) {
  const tz = typeof docuseal.timezone === "string" ? docuseal.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} docuseal
 */
export function secretKeyBaseVaultKey(docuseal) {
  const key =
    typeof docuseal.secret_key_base_vault_key === "string" &&
    docuseal.secret_key_base_vault_key.trim()
      ? docuseal.secret_key_base_vault_key.trim()
      : "HDC_DOCUSEAL_SECRET_KEY_BASE";
  return key;
}

/**
 * @param {Record<string, unknown>} docuseal
 */
export function dbPasswordVaultKey(docuseal) {
  const key =
    typeof docuseal.db_password_vault_key === "string" && docuseal.db_password_vault_key.trim()
      ? docuseal.db_password_vault_key.trim()
      : "HDC_DOCUSEAL_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} docuseal
 * @returns {URL | null}
 */
export function parsePublicUrl(docuseal) {
  const raw = typeof docuseal.public_url === "string" ? docuseal.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`docuseal.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("docuseal.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} docuseal
 * @param {string | null} [ctIp]
 * @returns {{ host: string | null; forceSsl: string | null }}
 */
export function resolveHostEnv(docuseal, ctIp = null) {
  const parsed = parsePublicUrl(docuseal);
  if (parsed) {
    return {
      host: parsed.origin.replace(/\/+$/, ""),
      forceSsl: parsed.hostname,
    };
  }
  const port = hostPort(docuseal);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) {
    return { host: `http://${ip}:${port}`, forceSsl: null };
  }
  return { host: null, forceSsl: null };
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/docuseal";
}

/**
 * @param {Record<string, unknown>} docuseal
 * @param {{ secretKeyBase: string; dbPassword: string }} secrets
 * @param {string | null} [ctIp]
 */
export function renderDocusealEnv(docuseal, secrets, ctIp = null) {
  const tag = normalizeImageTag(docuseal);
  const pgTag = normalizePostgresImageTag(docuseal);
  const port = hostPort(docuseal);
  const tz = normalizeTimezone(docuseal);
  const secretKeyBase = String(secrets.secretKeyBase || "").trim();
  const dbPassword = String(secrets.dbPassword || "").trim();
  if (!secretKeyBase) {
    throw new Error("DocuSeal SECRET_KEY_BASE is required");
  }
  if (!dbPassword) {
    throw new Error("DocuSeal DB password is required");
  }

  const dbUser = "docuseal";
  const dbName = "docuseal";
  const { host, forceSsl } = resolveHostEnv(docuseal, ctIp);

  const lines = [
    "# hdc-generated — docker compose",
    `DOCUSEAL_IMAGE_TAG=${tag}`,
    `POSTGRES_IMAGE_TAG=${pgTag}`,
    `DOCUSEAL_HOST_PORT=${port}`,
    `POSTGRES_USER=${dbUser}`,
    `POSTGRES_PASSWORD=${dbPassword}`,
    `POSTGRES_DB=${dbName}`,
    `SECRET_KEY_BASE=${secretKeyBase}`,
    `DATABASE_URL=postgresql://${dbUser}:${encodeURIComponent(dbPassword)}@postgres:5432/${dbName}`,
    `TZ=${tz}`,
  ];

  if (host) {
    lines.push(`HOST=${host}`);
  }
  if (forceSsl) {
    lines.push(`FORCE_SSL=${forceSsl}`);
  }

  for (const line of docusealMailEnvLines(docuseal)) {
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  app:
    image: docuseal/docuseal:\${DOCUSEAL_IMAGE_TAG}
    container_name: docuseal_app
    restart: unless-stopped
    ports:
      - "\${DOCUSEAL_HOST_PORT}:3000"
    env_file:
      - .env
    volumes:
      - ./data:/data/docuseal
    depends_on:
      postgres:
        condition: service_healthy
    networks:
      - docuseal

  postgres:
    image: postgres:\${POSTGRES_IMAGE_TAG}
    container_name: docuseal_db
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h localhost -U $$POSTGRES_USER"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 30s
    volumes:
      - docuseal-db-data:/var/lib/postgresql/data
    networks:
      - docuseal

networks:
  docuseal:

volumes:
  docuseal-db-data:
`;
}

/**
 * @param {Record<string, unknown>} docuseal
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(docuseal, ctIp = null) {
  const parsed = parsePublicUrl(docuseal);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(docuseal);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} docuseal
 */
export function resolveUpstreamUrl(ctIp, docuseal) {
  const port = hostPort(docuseal);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
