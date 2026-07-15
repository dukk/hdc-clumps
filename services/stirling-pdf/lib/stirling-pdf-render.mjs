/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function normalizeImage(stirlingPdf) {
  const img = typeof stirlingPdf.image === "string" ? stirlingPdf.image.trim() : "";
  if (!img) return "stirlingtools/stirling-pdf:latest";
  return img;
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function hostPort(stirlingPdf) {
  const p =
    typeof stirlingPdf.host_port === "number" ? stirlingPdf.host_port : Number(stirlingPdf.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8080;
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function memoryLimitMb(stirlingPdf) {
  const p =
    typeof stirlingPdf.memory_limit_mb === "number"
      ? stirlingPdf.memory_limit_mb
      : Number(stirlingPdf.memory_limit_mb);
  if (Number.isFinite(p) && p >= 256) return Math.floor(p);
  return 2048;
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function normalizeTimezone(stirlingPdf) {
  const tz = typeof stirlingPdf.timezone === "string" ? stirlingPdf.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function normalizeLangs(stirlingPdf) {
  const langs = typeof stirlingPdf.langs === "string" ? stirlingPdf.langs.trim() : "";
  return langs || "en_US";
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function securityBlock(stirlingPdf) {
  return isObject(stirlingPdf.security) ? stirlingPdf.security : {};
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function enableLogin(stirlingPdf) {
  const sec = securityBlock(stirlingPdf);
  return sec.enable_login !== false;
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function initialUsername(stirlingPdf) {
  const sec = securityBlock(stirlingPdf);
  const user = typeof sec.initial_username === "string" ? sec.initial_username.trim() : "";
  return user || "admin";
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function adminPasswordVaultKey(stirlingPdf) {
  const sec = securityBlock(stirlingPdf);
  const key =
    typeof sec.admin_password_vault_key === "string" && sec.admin_password_vault_key.trim()
      ? sec.admin_password_vault_key.trim()
      : "HDC_STIRLING_PDF_ADMIN_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 * @returns {URL | null}
 */
export function parsePublicUrl(stirlingPdf) {
  const raw = stirlingPdf.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`stirling_pdf.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("stirling_pdf.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/stirling-pdf";
}

/** Docker Compose `.env` treats `$` as interpolation; literal hashes need `$$`. */
export function escapeDockerComposeEnvValue(value) {
  return String(value).replace(/\$/g, "$$$$");
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 * @param {string} adminPassword
 */
export function renderStirlingPdfEnv(stirlingPdf, adminPassword) {
  const image = normalizeImage(stirlingPdf);
  const port = hostPort(stirlingPdf);
  const memMb = memoryLimitMb(stirlingPdf);
  const tz = normalizeTimezone(stirlingPdf);
  const langs = normalizeLangs(stirlingPdf);
  const login = enableLogin(stirlingPdf);
  const username = initialUsername(stirlingPdf);
  const appName =
    typeof stirlingPdf.ui_app_name === "string" && stirlingPdf.ui_app_name.trim()
      ? stirlingPdf.ui_app_name.trim()
      : "Stirling-PDF";

  const lines = [
    "# hdc-generated — docker compose",
    `STIRLING_PDF_IMAGE=${image}`,
    `STIRLING_PDF_HOST_PORT=${port}`,
    `STIRLING_PDF_MEMORY_LIMIT=${memMb}M`,
    `TZ=${tz}`,
    `LANGS=${langs}`,
    `UI_APPNAME=${appName}`,
    "DOCKER_ENABLE_SECURITY=true",
    `SECURITY_ENABLELOGIN=${login ? "true" : "false"}`,
  ];

  if (login) {
    lines.push(`SECURITY_INITIALLOGIN_USERNAME=${username}`);
    lines.push(
      `SECURITY_INITIALLOGIN_PASSWORD=${escapeDockerComposeEnvValue(adminPassword)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 */
export function renderComposeYaml(stirlingPdf) {
  const _cfg = isObject(stirlingPdf) ? stirlingPdf : {};
  return `services:
  stirling-pdf:
    container_name: stirling-pdf
    image: \${STIRLING_PDF_IMAGE}
    restart: unless-stopped
    ports:
      - "\${STIRLING_PDF_HOST_PORT}:8080/tcp"
    volumes:
      - ./configs:/configs
      - ./tessdata:/usr/share/tessdata
      - ./logs:/logs
      - ./pipeline:/pipeline
    env_file:
      - .env
    deploy:
      resources:
        limits:
          memory: \${STIRLING_PDF_MEMORY_LIMIT}
`;
}

/**
 * @param {Record<string, unknown>} stirlingPdf
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(stirlingPdf, ctIp = null) {
  const parsed = parsePublicUrl(stirlingPdf);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(stirlingPdf);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} stirlingPdf
 */
export function resolveUpstreamUrl(ctIp, stirlingPdf) {
  const port = hostPort(stirlingPdf);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
