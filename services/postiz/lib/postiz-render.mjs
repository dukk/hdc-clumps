import { postizMailEnvEntries } from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} postiz
 */
export function normalizeVersion(postiz) {
  const v = typeof postiz.version === "string" ? postiz.version.trim() : "latest";
  return v || "latest";
}

/**
 * @param {Record<string, unknown>} postiz
 */
export function listenPort(postiz) {
  const p = typeof postiz.listen_port === "number" ? postiz.listen_port : Number(postiz.listen_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 80;
}

/**
 * @param {Record<string, unknown>} postiz
 */
export function dbPasswordVaultKey(postiz) {
  const key =
    typeof postiz.db_password_vault_key === "string" && postiz.db_password_vault_key.trim()
      ? postiz.db_password_vault_key.trim()
      : "HDC_POSTIZ_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} postiz
 */
export function jwtSecretVaultKey(postiz) {
  const key =
    typeof postiz.jwt_secret_vault_key === "string" && postiz.jwt_secret_vault_key.trim()
      ? postiz.jwt_secret_vault_key.trim()
      : "HDC_POSTIZ_JWT_SECRET";
  return key;
}

/**
 * @param {Record<string, unknown>} install
 */
export function appDir(install) {
  return typeof install.app_dir === "string" && install.app_dir.trim()
    ? install.app_dir.trim()
    : "/opt/postiz";
}

/**
 * @param {string | null | undefined} raw
 */
export function normalizePublicUrl(raw) {
  if (raw === null || raw === undefined) return null;
  const u = String(raw).trim();
  if (!u) return null;
  return u.replace(/\/+$/, "");
}

/**
 * Resolve public base URL for .env (no trailing slash).
 * @param {Record<string, unknown>} postiz
 * @param {string | null} ctIp
 */
export function resolveBaseUrl(postiz, ctIp) {
  const configured = normalizePublicUrl(postiz.public_url);
  if (configured) return configured;
  if (ctIp) return `http://${ctIp}`;
  return null;
}

/**
 * @param {string} baseUrl
 */
function isHttpUrl(baseUrl) {
  return /^http:\/\//i.test(baseUrl);
}

/**
 * @param {Record<string, unknown>} postiz
 * @param {string} dbPassword
 * @param {string} jwtSecret
 * @param {string} baseUrl
 */
export function renderPostizEnv(postiz, dbPassword, jwtSecret, baseUrl) {
  const storage =
    typeof postiz.storage_provider === "string" && postiz.storage_provider.trim()
      ? postiz.storage_provider.trim()
      : "local";
  const apiUrl = `${baseUrl}/api`;
  const notSecured = isHttpUrl(baseUrl) ? "true" : "false";
  const lines = [
    `DATABASE_URL=postgresql://postiz:${dbPassword}@localhost:5432/postiz`,
    "REDIS_URL=redis://localhost:6379",
    `JWT_SECRET=${jwtSecret}`,
    `MAIN_URL=${baseUrl}`,
    `FRONTEND_URL=${baseUrl}`,
    `NEXT_PUBLIC_BACKEND_URL=${apiUrl}`,
    "BACKEND_INTERNAL_URL=http://localhost:3000",
    `NOT_SECURED=${notSecured}`,
    "TEMPORAL_ADDRESS=localhost:7233",
    "IS_GENERAL=true",
    `STORAGE_PROVIDER=${storage}`,
    "UPLOAD_DIRECTORY=/opt/postiz/uploads",
    "NEXT_PUBLIC_UPLOAD_DIRECTORY=/uploads",
    "NX_ADD_PLUGINS=false",
  ];

  const mailExtra = postizMailEnvEntries(postiz);
  const extra = { ...mailExtra, ...(isObject(postiz.env_extra) ? postiz.env_extra : {}) };
  for (const [key, val] of Object.entries(extra)) {
    if (!key || val === undefined || val === null) continue;
    lines.push(`${key}=${String(val)}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} postiz
 * @param {string | null} ctIp
 */
export function resolveAccessUrl(postiz, ctIp) {
  const base = resolveBaseUrl(postiz, ctIp);
  if (!base) return null;
  const port = listenPort(postiz);
  if (isHttpUrl(base) && ctIp && !postiz.public_url) {
    return port === 80 ? base : `${base}:${port}`;
  }
  return base;
}
