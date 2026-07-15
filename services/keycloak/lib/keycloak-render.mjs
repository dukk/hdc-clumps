/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Public hostname URL for KC_HOSTNAME (nginx-waf / edge TLS).
 * Prefers `external_url`; falls back to `public_url` when external is unset.
 * @param {Record<string, unknown>} keycloak
 */
export function normalizeExternalUrl(keycloak) {
  const external =
    typeof keycloak.external_url === "string" ? keycloak.external_url.trim() : "";
  const publicUrl =
    typeof keycloak.public_url === "string" ? keycloak.public_url.trim() : "";
  const url = external || publicUrl;
  if (!url) throw new Error("keycloak.external_url (or public_url) is required");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("keycloak.external_url must start with http:// or https://");
  }
  return url.replace(/\/+$/, "");
}

/**
 * Warn when public_url and external_url both set but disagree (OIDC issuer mismatch).
 * @param {Record<string, unknown>} keycloak
 * @param {{ write?: (s: string) => void }} [opts]
 */
export function warnPublicUrlMismatch(keycloak, opts = {}) {
  const write = typeof opts.write === "function" ? opts.write : (s) => process.stderr.write(s);
  const external =
    typeof keycloak.external_url === "string" ? keycloak.external_url.trim().replace(/\/+$/, "") : "";
  const publicUrl =
    typeof keycloak.public_url === "string" ? keycloak.public_url.trim().replace(/\/+$/, "") : "";
  if (!external || !publicUrl) return;
  if (external.toLowerCase() === publicUrl.toLowerCase()) return;
  write(
    `[hdc] keycloak: public_url (${publicUrl}) differs from external_url (${external}); KC_HOSTNAME uses external_url\n`,
  );
}

/**
 * @param {Record<string, unknown>} keycloak
 */
export function hostPort(keycloak) {
  const p = typeof keycloak.host_port === "number" ? keycloak.host_port : Number(keycloak.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8080;
}

/**
 * @param {Record<string, unknown>} keycloak
 */
export function imageTag(keycloak) {
  const t = typeof keycloak.image_tag === "string" ? keycloak.image_tag.trim() : "";
  return t || "latest";
}

/**
 * Master-realm admin username for Admin API + compose bootstrap env.
 * Precedence: `keycloak.admin_user` → env `HDC_KEYCLOAK_ADMIN_USER` → `"admin"`.
 *
 * @param {Record<string, unknown>} keycloak
 * @param {NodeJS.ProcessEnv} [env]
 */
export function adminUser(keycloak, env = process.env) {
  const fromCfg = typeof keycloak.admin_user === "string" ? keycloak.admin_user.trim() : "";
  if (fromCfg) return fromCfg;
  const fromEnv = String(env.HDC_KEYCLOAK_ADMIN_USER ?? "").trim();
  if (fromEnv) return fromEnv;
  return "admin";
}

/**
 * @param {Record<string, unknown>} keycloak
 */
export function adminPasswordVaultKey(keycloak) {
  const key =
    typeof keycloak.admin_password_vault_key === "string" && keycloak.admin_password_vault_key.trim()
      ? keycloak.admin_password_vault_key.trim()
      : "HDC_KEYCLOAK_ADMIN_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} keycloak
 */
export function databaseConfig(keycloak) {
  const db = isObject(keycloak.database) ? keycloak.database : {};
  const mode = db.mode === "external" ? "external" : "bundled";
  const bundled = isObject(db.bundled) ? db.bundled : {};
  const external = isObject(db.external) ? db.external : {};
  return {
    mode,
    bundled: {
      postgres_db:
        typeof bundled.postgres_db === "string" && bundled.postgres_db.trim()
          ? bundled.postgres_db.trim()
          : "keycloak",
      postgres_user:
        typeof bundled.postgres_user === "string" && bundled.postgres_user.trim()
          ? bundled.postgres_user.trim()
          : "keycloak",
      postgres_password_vault_key:
        typeof bundled.postgres_password_vault_key === "string" &&
        bundled.postgres_password_vault_key.trim()
          ? bundled.postgres_password_vault_key.trim()
          : "HDC_KEYCLOAK_DB_PASSWORD",
    },
    external: {
      host: typeof external.host === "string" ? external.host.trim() : "",
      port:
        typeof external.port === "number" && Number.isFinite(external.port)
          ? Math.floor(external.port)
          : Number.isFinite(Number(external.port))
            ? Number(external.port)
            : 5432,
      database:
        typeof external.database === "string" && external.database.trim()
          ? external.database.trim()
          : "keycloak",
      username:
        typeof external.username === "string" && external.username.trim()
          ? external.username.trim()
          : "keycloak",
      password_vault_key:
        typeof external.password_vault_key === "string" && external.password_vault_key.trim()
          ? external.password_vault_key.trim()
          : "HDC_KEYCLOAK_DB_PASSWORD",
    },
  };
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/keycloak";
}

/**
 * @param {Record<string, unknown>} keycloak
 * @param {{ adminPassword: string; dbPassword: string }} secrets
 */
export function renderKeycloakEnv(keycloak, secrets) {
  const db = databaseConfig(keycloak);
  const hostnameUrl = normalizeExternalUrl(keycloak);
  const admin = adminUser(keycloak);
  const lines = [
    "# hdc-generated — docker compose",
    `KEYCLOAK_IMAGE_TAG=${imageTag(keycloak)}`,
    `KEYCLOAK_HOST_PORT=${hostPort(keycloak)}`,
    // Keycloak 26 production behind edge TLS (nginx-waf)
    `KC_HOSTNAME=${hostnameUrl}`,
    "KC_HTTP_ENABLED=true",
    "KC_HEALTH_ENABLED=true",
    "KC_METRICS_ENABLED=true",
    "KC_PROXY_HEADERS=xforwarded",
    // Bootstrap admin (Keycloak 26+) plus legacy aliases
    `KC_BOOTSTRAP_ADMIN_USERNAME=${admin}`,
    `KC_BOOTSTRAP_ADMIN_PASSWORD=${secrets.adminPassword}`,
    `KEYCLOAK_ADMIN=${admin}`,
    `KEYCLOAK_ADMIN_PASSWORD=${secrets.adminPassword}`,
  ];
  if (db.mode === "bundled") {
    lines.push(
      "KC_DB=postgres",
      "KC_DB_URL_HOST=postgres",
      "KC_DB_URL_PORT=5432",
      `KC_DB_URL_DATABASE=${db.bundled.postgres_db}`,
      `KC_DB_USERNAME=${db.bundled.postgres_user}`,
      `KC_DB_PASSWORD=${secrets.dbPassword}`,
      `POSTGRES_DB=${db.bundled.postgres_db}`,
      `POSTGRES_USER=${db.bundled.postgres_user}`,
      `POSTGRES_PASSWORD=${secrets.dbPassword}`,
    );
  } else {
    lines.push(
      "KC_DB=postgres",
      `KC_DB_URL_HOST=${db.external.host}`,
      `KC_DB_URL_PORT=${db.external.port}`,
      `KC_DB_URL_DATABASE=${db.external.database}`,
      `KC_DB_USERNAME=${db.external.username}`,
      `KC_DB_PASSWORD=${secrets.dbPassword}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} keycloak
 */
export function renderComposeYaml(keycloak) {
  const db = databaseConfig(keycloak);
  const securityOpt = `    security_opt:
      - apparmor:unconfined
`;
  if (db.mode === "bundled") {
    return `services:
  keycloak:
    image: quay.io/keycloak/keycloak:\${KEYCLOAK_IMAGE_TAG}
    command: ["start"]
    restart: unless-stopped
    depends_on:
      - postgres
    ports:
      - "\${KEYCLOAK_HOST_PORT}:8080"
      - "9000:9000"
    env_file:
      - .env
${securityOpt}
  postgres:
    image: postgres:16
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - keycloak-postgres-data:/var/lib/postgresql/data
${securityOpt}
volumes:
  keycloak-postgres-data: {}
`;
  }
  return `services:
  keycloak:
    image: quay.io/keycloak/keycloak:\${KEYCLOAK_IMAGE_TAG}
    command: ["start"]
    restart: unless-stopped
    ports:
      - "\${KEYCLOAK_HOST_PORT}:8080"
      - "9000:9000"
    env_file:
      - .env
${securityOpt}`;
}
