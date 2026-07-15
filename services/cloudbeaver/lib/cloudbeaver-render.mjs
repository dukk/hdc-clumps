/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const DEFAULT_IMAGE = "dbeaver/cloudbeaver:latest";
const CONTAINER_PORT = 8978;

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function normalizeImage(cloudbeaver) {
  const img = typeof cloudbeaver.image === "string" ? cloudbeaver.image.trim() : "";
  return img || DEFAULT_IMAGE;
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function hostPort(cloudbeaver) {
  const p =
    typeof cloudbeaver.host_port === "number" ? cloudbeaver.host_port : Number(cloudbeaver.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return CONTAINER_PORT;
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function containerPort() {
  return CONTAINER_PORT;
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function adminBlock(cloudbeaver) {
  return isObject(cloudbeaver.admin) ? cloudbeaver.admin : {};
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function adminEnabled(cloudbeaver) {
  const admin = adminBlock(cloudbeaver);
  return admin.enabled !== false;
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function adminUsername(cloudbeaver) {
  const admin = adminBlock(cloudbeaver);
  const user = typeof admin.username === "string" ? admin.username.trim() : "";
  return user || "cbadmin";
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function serverName(cloudbeaver) {
  const admin = adminBlock(cloudbeaver);
  const name = typeof admin.server_name === "string" ? admin.server_name.trim() : "";
  return name || "HDC CloudBeaver";
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function adminPasswordVaultKey(cloudbeaver) {
  const admin = adminBlock(cloudbeaver);
  const key =
    typeof admin.admin_password_vault_key === "string" && admin.admin_password_vault_key.trim()
      ? admin.admin_password_vault_key.trim()
      : "HDC_CLOUDBEAVER_ADMIN_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 * @returns {URL | null}
 */
export function parsePublicUrl(cloudbeaver) {
  const raw = cloudbeaver.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`cloudbeaver.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("cloudbeaver.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/cloudbeaver";
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 * @returns {string[]}
 */
export function extraHostsList(cloudbeaver) {
  const raw = cloudbeaver.extra_hosts;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => typeof e === "string" && e.trim())
    .map((e) => e.trim());
}

/** Docker Compose `.env` treats `$` as interpolation; literal hashes need `$$`. */
export function escapeDockerComposeEnvValue(value) {
  return String(value).replace(/\$/g, "$$$$");
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 * @param {string | null} [ctIp]
 */
export function resolveServerUrl(cloudbeaver, ctIp = null) {
  const parsed = parsePublicUrl(cloudbeaver);
  if (parsed) {
    const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
    return `${parsed.origin}${path === "/" ? "/" : path}`;
  }
  const port = hostPort(cloudbeaver);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return `http://localhost:${port}/`;
  return `http://${ip}:${port}/`;
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 * @param {string | null} [ctIp]
 * @param {string} [adminPassword]
 */
export function renderCloudbeaverEnv(cloudbeaver, ctIp = null, adminPassword = "") {
  const image = normalizeImage(cloudbeaver);
  const port = hostPort(cloudbeaver);
  const serverUrl = resolveServerUrl(cloudbeaver, ctIp);

  const lines = [
    "# hdc-generated — docker compose env",
    `CLOUDBEAVER_IMAGE=${image}`,
    `CLOUDBEAVER_HOST_PORT=${port}`,
    `CLOUDBEAVER_WEB_SERVER_PORT=${CONTAINER_PORT}`,
    `CB_SERVER_NAME=${serverName(cloudbeaver)}`,
    `CB_SERVER_URL=${serverUrl}`,
  ];

  if (adminEnabled(cloudbeaver)) {
    const pwd =
      typeof adminPassword === "string" && adminPassword.trim() ? adminPassword.trim() : "";
    lines.push(`CB_ADMIN_NAME=${adminUsername(cloudbeaver)}`);
    if (pwd) {
      lines.push(`CB_ADMIN_PASSWORD=${escapeDockerComposeEnvValue(pwd)}`);
    }
  }

  const parsed = parsePublicUrl(cloudbeaver);
  if (parsed?.protocol === "https:") {
    lines.push("CLOUDBEAVER_FORCE_HTTPS=true");
    const rootUri = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
    lines.push(`CLOUDBEAVER_ROOT_URI=${rootUri}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function renderExtraHostsYaml(cloudbeaver) {
  const hosts = extraHostsList(cloudbeaver);
  if (!hosts.length) return "";
  const lines = hosts.map((h) => `      - "${h.replace(/"/g, '\\"')}"`);
  return `    extra_hosts:\n${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 */
export function renderComposeYaml(cloudbeaver) {
  const extraHosts = renderExtraHostsYaml(cloudbeaver);
  return `services:
  cloudbeaver:
    container_name: cloudbeaver
    image: \${CLOUDBEAVER_IMAGE}
    restart: unless-stopped
    ports:
      - "\${CLOUDBEAVER_HOST_PORT}:${CONTAINER_PORT}/tcp"
    volumes:
      - ./workspace:/opt/cloudbeaver/workspace
    env_file:
      - .env
${extraHosts}`;
}

/**
 * @param {Record<string, unknown>} cloudbeaver
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(cloudbeaver, ctIp = null) {
  const parsed = parsePublicUrl(cloudbeaver);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(cloudbeaver);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} cloudbeaver
 */
export function resolveUpstreamUrl(ctIp, cloudbeaver) {
  const port = hostPort(cloudbeaver);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
