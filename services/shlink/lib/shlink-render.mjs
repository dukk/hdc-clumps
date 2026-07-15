/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function normalizeImageTag(shlink) {
  const t = typeof shlink.image_tag === "string" ? shlink.image_tag.trim() : "";
  return t || "stable";
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function normalizePostgresImageTag(shlink) {
  const t =
    typeof shlink.postgres_image_tag === "string" ? shlink.postgres_image_tag.trim() : "";
  return t || "16-alpine";
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function normalizeRedisImageTag(shlink) {
  const t = typeof shlink.redis_image_tag === "string" ? shlink.redis_image_tag.trim() : "";
  return t || "7-alpine";
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function hostPort(shlink) {
  const p = typeof shlink.host_port === "number" ? shlink.host_port : Number(shlink.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8080;
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function normalizeTimezone(shlink) {
  const tz = typeof shlink.timezone === "string" ? shlink.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function normalizeDefaultDomain(shlink) {
  const raw = typeof shlink.default_domain === "string" ? shlink.default_domain.trim() : "";
  if (!raw) {
    throw new Error("shlink.default_domain is required");
  }
  if (raw.includes("://") || raw.includes("/")) {
    throw new Error("shlink.default_domain must be a hostname only (no scheme or path)");
  }
  return raw.toLowerCase();
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function dbPasswordVaultKey(shlink) {
  const key =
    typeof shlink.db_password_vault_key === "string" && shlink.db_password_vault_key.trim()
      ? shlink.db_password_vault_key.trim()
      : "HDC_SHLINK_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function initialApiKeyVaultKey(shlink) {
  const key =
    typeof shlink.initial_api_key_vault_key === "string" &&
    shlink.initial_api_key_vault_key.trim()
      ? shlink.initial_api_key_vault_key.trim()
      : "HDC_SHLINK_INITIAL_API_KEY";
  return key;
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function geoliteLicenseKeyVaultKey(shlink) {
  const key =
    typeof shlink.geolite_license_key_vault_key === "string" &&
    shlink.geolite_license_key_vault_key.trim()
      ? shlink.geolite_license_key_vault_key.trim()
      : "HDC_SHLINK_GEOLITE_LICENSE_KEY";
  return key;
}

/**
 * @param {Record<string, unknown>} shlink
 * @returns {URL | null}
 */
export function parsePublicUrl(shlink) {
  const raw = typeof shlink.public_url === "string" ? shlink.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`shlink.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("shlink.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function webClientConfig(shlink) {
  const wc = isObject(shlink.web_client) ? shlink.web_client : {};
  if (wc.enabled === false) {
    return { enabled: false, image_tag: "stable", host_port: 8081, public_url: null };
  }
  const imageTag =
    typeof wc.image_tag === "string" && wc.image_tag.trim() ? wc.image_tag.trim() : "stable";
  const port =
    typeof wc.host_port === "number" && wc.host_port >= 1 && wc.host_port <= 65535
      ? Math.floor(wc.host_port)
      : Number(wc.host_port);
  const hostPortNum = Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.floor(port) : 8081;
  let publicUrl = null;
  const raw = typeof wc.public_url === "string" ? wc.public_url.trim() : "";
  if (raw) {
    try {
      publicUrl = new URL(raw);
    } catch {
      throw new Error(`shlink.web_client.public_url is not a valid URL: ${JSON.stringify(raw)}`);
    }
    if (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:") {
      throw new Error("shlink.web_client.public_url must use http:// or https://");
    }
  }
  return { enabled: true, image_tag: imageTag, host_port: hostPortNum, public_url: publicUrl };
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function validateDomainConsistency(shlink) {
  const defaultDomain = normalizeDefaultDomain(shlink);
  const parsed = parsePublicUrl(shlink);
  if (parsed && parsed.hostname.toLowerCase() !== defaultDomain) {
    throw new Error(
      `shlink.default_domain (${JSON.stringify(defaultDomain)}) must match shlink.public_url hostname (${JSON.stringify(parsed.hostname)})`,
    );
  }
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function isHttpsEnabled(shlink) {
  const parsed = parsePublicUrl(shlink);
  return parsed ? parsed.protocol === "https:" : false;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/shlink";
}

/**
 * @param {Record<string, unknown>} shlink
 * @param {{ dbPassword: string; initialApiKey: string; geoliteLicenseKey?: string | null }} secrets
 */
export function renderShlinkEnv(shlink, secrets) {
  validateDomainConsistency(shlink);
  const tag = normalizeImageTag(shlink);
  const pgTag = normalizePostgresImageTag(shlink);
  const redisTag = normalizeRedisImageTag(shlink);
  const port = hostPort(shlink);
  const tz = normalizeTimezone(shlink);
  const defaultDomain = normalizeDefaultDomain(shlink);
  const httpsEnabled = isHttpsEnabled(shlink);
  const wc = webClientConfig(shlink);
  const dbPassword = String(secrets.dbPassword || "").trim();
  const initialApiKey = String(secrets.initialApiKey || "").trim();
  if (!dbPassword) {
    throw new Error("SHLINK DB password is required");
  }
  if (!initialApiKey) {
    throw new Error("SHLINK INITIAL_API_KEY is required");
  }

  const dbUser = "shlink";
  const dbName = "shlink";
  const parsed = parsePublicUrl(shlink);
  const serverUrl = parsed ? parsed.origin.replace(/\/+$/, "") : `http://${defaultDomain}:${port}`;

  const lines = [
    "# hdc-generated — docker compose",
    `SHLINK_IMAGE_TAG=${tag}`,
    `POSTGRES_IMAGE_TAG=${pgTag}`,
    `REDIS_IMAGE_TAG=${redisTag}`,
    `SHLINK_HOST_PORT=${port}`,
    `DEFAULT_DOMAIN=${defaultDomain}`,
    `IS_HTTPS_ENABLED=${httpsEnabled ? "true" : "false"}`,
    `INITIAL_API_KEY=${initialApiKey}`,
    `DB_DRIVER=postgres`,
    `DB_HOST=db`,
    `DB_PORT=5432`,
    `DB_NAME=${dbName}`,
    `DB_USER=${dbUser}`,
    `DB_PASSWORD=${dbPassword}`,
    `REDIS_SERVERS=redis:6379`,
    `POSTGRES_USER=${dbUser}`,
    `POSTGRES_PASSWORD=${dbPassword}`,
    `POSTGRES_DB=${dbName}`,
    `TZ=${tz}`,
    `SHLINK_SERVER_URL=${serverUrl}`,
    `WEB_CLIENT_ENABLED=${wc.enabled ? "true" : "false"}`,
    `WEB_CLIENT_IMAGE_TAG=${wc.image_tag}`,
    `WEB_CLIENT_HOST_PORT=${wc.host_port}`,
    `SHLINK_SERVER_API_KEY=${initialApiKey}`,
  ];

  const geolite = typeof secrets.geoliteLicenseKey === "string" ? secrets.geoliteLicenseKey.trim() : "";
  if (geolite) {
    lines.push(`GEOLITE_LICENSE_KEY=${geolite}`);
  }

  if (wc.enabled && wc.public_url) {
    lines.push(`WEB_CLIENT_PUBLIC_URL=${wc.public_url.origin.replace(/\/+$/, "")}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} shlink
 */
export function renderComposeYaml(shlink) {
  const wc = webClientConfig(shlink);
  const webClientBlock = wc.enabled
    ? `
  web_client:
    image: shlinkio/shlink-web-client:\${WEB_CLIENT_IMAGE_TAG}
    container_name: shlink_web_client
    restart: unless-stopped
    ports:
      - "\${WEB_CLIENT_HOST_PORT}:80"
    networks:
      - shlink
    depends_on:
      - shlink
    environment:
      SHLINK_SERVER_URL: \${SHLINK_SERVER_URL}
      SHLINK_SERVER_API_KEY: \${SHLINK_SERVER_API_KEY}
`
    : "";

  return `services:
  shlink:
    image: shlinkio/shlink:\${SHLINK_IMAGE_TAG}
    container_name: shlink_app
    restart: unless-stopped
    ports:
      - "\${SHLINK_HOST_PORT}:8080"
    networks:
      - shlink
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    env_file:
      - .env
    environment:
      DEFAULT_DOMAIN: \${DEFAULT_DOMAIN}
      IS_HTTPS_ENABLED: \${IS_HTTPS_ENABLED}
      INITIAL_API_KEY: \${INITIAL_API_KEY}
      DB_DRIVER: postgres
      DB_HOST: db
      DB_PORT: "5432"
      DB_NAME: \${DB_NAME}
      DB_USER: \${DB_USER}
      DB_PASSWORD: \${DB_PASSWORD}
      REDIS_SERVERS: redis:6379
      TZ: \${TZ}

  db:
    image: postgres:\${POSTGRES_IMAGE_TAG}
    container_name: shlink_db
    restart: unless-stopped
    ports:
      - "127.0.0.1:5432:5432"
    networks:
      - shlink
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shlink"]
      interval: 10s
      timeout: 5s
      retries: 6
    volumes:
      - shlink-db-data:/var/lib/postgresql/data

  redis:
    image: redis:\${REDIS_IMAGE_TAG}
    container_name: shlink_redis
    restart: unless-stopped
    networks:
      - shlink
    volumes:
      - shlink-redis-data:/data
${webClientBlock}
networks:
  shlink:

volumes:
  shlink-db-data:
  shlink-redis-data:
`;
}

/**
 * @param {Record<string, unknown>} shlink
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(shlink, ctIp = null) {
  const parsed = parsePublicUrl(shlink);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(shlink);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${port}`;
  return null;
}

/**
 * @param {Record<string, unknown>} shlink
 * @param {string | null} [ctIp]
 */
export function resolveWebClientUrl(shlink, ctIp = null) {
  const wc = webClientConfig(shlink);
  if (!wc.enabled) return null;
  if (wc.public_url) return wc.public_url.origin.replace(/\/+$/, "");
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (ip) return `http://${ip}:${wc.host_port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} shlink
 */
export function resolveUpstreamUrl(ctIp, shlink) {
  const port = hostPort(shlink);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} shlink
 */
export function resolveWebClientUpstreamUrl(ctIp, shlink) {
  const wc = webClientConfig(shlink);
  if (!wc.enabled || !ctIp) return null;
  return `http://${ctIp}:${wc.host_port}`;
}
