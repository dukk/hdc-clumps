/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const DEFAULT_IMAGE = "ghcr.io/dukk/waddle-view-controller";
const DEFAULT_IMAGE_TAG = "latest";
const DEFAULT_HOST_PORT = 8443;
const DEFAULT_SESSION_SECRET_VAULT_KEY = "HDC_WADDLE_VIEW_CONTROLLER_SESSION_SECRET";

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeImage(cfg) {
  const img = typeof cfg.image === "string" ? cfg.image.trim() : "";
  return img || DEFAULT_IMAGE;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeImageTag(cfg) {
  const t = typeof cfg.image_tag === "string" ? cfg.image_tag.trim() : "";
  return t || DEFAULT_IMAGE_TAG;
}

/**
 * Full Docker image reference. If `image` already includes a tag (`repo:tag`),
 * return it as-is; otherwise append `:${image_tag}`.
 *
 * @param {Record<string, unknown>} cfg
 */
export function resolveImageRef(cfg) {
  const image = normalizeImage(cfg);
  if (image.includes(":")) return image;
  return `${image}:${normalizeImageTag(cfg)}`;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function hostPort(cfg) {
  const p = typeof cfg.host_port === "number" ? cfg.host_port : Number(cfg.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return DEFAULT_HOST_PORT;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function authEnabled(cfg) {
  return cfg.auth_enabled !== false;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function sessionSecretVaultKey(cfg) {
  const key =
    typeof cfg.session_secret_vault_key === "string" && cfg.session_secret_vault_key.trim()
      ? cfg.session_secret_vault_key.trim()
      : DEFAULT_SESSION_SECRET_VAULT_KEY;
  return key;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function clientIdentifier(cfg) {
  const id = typeof cfg.client_identifier === "string" ? cfg.client_identifier.trim() : "";
  return id || null;
}

/**
 * @param {Record<string, unknown>} cfg
 * @returns {URL | null}
 */
export function parsePublicUrl(cfg) {
  const raw = cfg.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`waddle_view_controller.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("waddle_view_controller.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/waddle-view-controller";
}

/**
 * @param {Record<string, unknown>} install
 */
export function dataDir(install) {
  return `${composeDir(install)}/data`;
}

/** Docker Compose `.env` treats `$` as interpolation; literal hashes need `$$`. */
export function escapeDockerComposeEnvValue(value) {
  return String(value).replace(/\$/g, "$$$$");
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} [sessionSecret]
 */
export function renderWaddleViewControllerEnv(cfg, sessionSecret = "") {
  const image = resolveImageRef(cfg);
  const port = hostPort(cfg);
  const auth = authEnabled(cfg);
  const clientId = clientIdentifier(cfg);

  const lines = [
    "# hdc-generated — docker compose",
    `WADDLE_VIEW_CONTROLLER_IMAGE=${image}`,
    `WADDLE_VIEW_CONTROLLER_HOST_PORT=${port}`,
    `WADDLE_CONTROLLER_AUTH_ENABLED=${auth ? "1" : "0"}`,
  ];

  if (auth) {
    lines.push(
      `WADDLE_CONTROLLER_SESSION_SECRET=${escapeDockerComposeEnvValue(sessionSecret)}`,
    );
  }

  if (clientId) {
    lines.push(`WADDLE_CONTROLLER_CLIENT_IDENTIFIER=${escapeDockerComposeEnvValue(clientId)}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} [_cfg]
 */
export function renderComposeYaml(_cfg) {
  return `services:
  waddle-view-controller:
    container_name: waddle-view-controller
    image: \${WADDLE_VIEW_CONTROLLER_IMAGE}
    restart: unless-stopped
    ports:
      - "\${WADDLE_VIEW_CONTROLLER_HOST_PORT}:443/tcp"
    volumes:
      - ./data:/var/lib/waddle-controller
    env_file:
      - .env
`;
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(cfg, ctIp = null) {
  const parsed = parsePublicUrl(cfg);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(cfg);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `https://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} cfg
 */
export function resolveUpstreamUrl(ctIp, cfg) {
  const port = hostPort(cfg);
  if (ctIp) return `https://${ctIp}:${port}`;
  return null;
}

export {
  DEFAULT_IMAGE,
  DEFAULT_IMAGE_TAG,
  DEFAULT_HOST_PORT,
  DEFAULT_SESSION_SECRET_VAULT_KEY,
};
