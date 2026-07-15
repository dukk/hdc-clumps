/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const DEFAULT_FRONTEND_IMAGE = "ghcr.io/rackulalives/rackula:persist";
const DEFAULT_API_IMAGE = "ghcr.io/rackulalives/rackula-api:latest";

/**
 * @param {Record<string, unknown>} rackula
 */
export function normalizeFrontendImage(rackula) {
  const img = typeof rackula.frontend_image === "string" ? rackula.frontend_image.trim() : "";
  return img || DEFAULT_FRONTEND_IMAGE;
}

/**
 * @param {Record<string, unknown>} rackula
 */
export function normalizeApiImage(rackula) {
  const img = typeof rackula.api_image === "string" ? rackula.api_image.trim() : "";
  return img || DEFAULT_API_IMAGE;
}

/**
 * @param {Record<string, unknown>} rackula
 */
export function hostPort(rackula) {
  const p = typeof rackula.host_port === "number" ? rackula.host_port : Number(rackula.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8080;
}

/**
 * @param {Record<string, unknown>} rackula
 * @returns {URL | null}
 */
export function parsePublicUrl(rackula) {
  const raw = rackula.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`rackula.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("rackula.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/rackula";
}

/**
 * @param {Record<string, unknown>} install
 */
export function dataDir(install) {
  return `${composeDir(install)}/data`;
}

/**
 * @param {Record<string, unknown>} rackula
 * @param {string | null} [ctIp]
 */
export function resolveCorsOrigin(rackula, ctIp = null) {
  const explicit =
    typeof rackula.cors_origin === "string" && rackula.cors_origin.trim()
      ? rackula.cors_origin.trim()
      : "";
  if (explicit) return explicit;
  const parsed = parsePublicUrl(rackula);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(rackula);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return `http://localhost:${port}`;
  return `http://${ip}:${port}`;
}

/**
 * @param {Record<string, unknown>} rackula
 */
export function trustProxyFlag(rackula) {
  const explicit = rackula.trust_proxy;
  if (explicit === true || explicit === 1 || explicit === "1") return "1";
  if (explicit === false || explicit === 0 || explicit === "0") return "0";
  const parsed = parsePublicUrl(rackula);
  return parsed?.protocol === "https:" ? "1" : "0";
}

/**
 * @param {Record<string, unknown>} rackula
 */
export function apiWriteTokenEnabled(rackula) {
  return rackula.api_write_token_enabled === true;
}

/**
 * @param {Record<string, unknown>} rackula
 * @param {string | null} [ctIp]
 * @param {string | null} [apiWriteToken]
 */
export function renderEnvFile(rackula, ctIp = null, apiWriteToken = null) {
  const port = hostPort(rackula);
  const cors = resolveCorsOrigin(rackula, ctIp);
  const trustProxy = trustProxyFlag(rackula);
  const token =
    apiWriteTokenEnabled(rackula) && typeof apiWriteToken === "string" && apiWriteToken.trim()
      ? apiWriteToken.trim()
      : "";

  const lines = [
    "# hdc-generated — docker compose env",
    `RACKULA_PORT=${port}`,
    `RACKULA_LISTEN_PORT=${port}`,
    `RACKULA_API_PORT=3001`,
    "API_HOST=rackula-api",
    "API_PORT=3001",
    `CORS_ORIGIN=${cors}`,
    `RACKULA_TRUST_PROXY=${trustProxy}`,
    "RACKULA_AUTH_MODE=none",
    "ALLOW_INSECURE_CORS=false",
    "NGINX_RESOLVER=127.0.0.11",
  ];
  if (token) {
    lines.push(`RACKULA_API_WRITE_TOKEN=${token}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} rackula
 */
export function renderComposeYaml(rackula) {
  const frontend = normalizeFrontendImage(rackula);
  const api = normalizeApiImage(rackula);
  return `services:
  rackula:
    image: ${frontend}
    container_name: rackula
    ports:
      - "\${RACKULA_PORT:-8080}:\${RACKULA_LISTEN_PORT:-8080}"
    environment:
      - API_HOST=rackula-api
      - API_PORT=\${RACKULA_API_PORT:-3001}
      - RACKULA_LISTEN_PORT=\${RACKULA_LISTEN_PORT:-8080}
      - API_WRITE_TOKEN=\${RACKULA_API_WRITE_TOKEN:-}
      - RACKULA_AUTH_MODE=\${RACKULA_AUTH_MODE:-none}
      - RACKULA_ENABLE_IPV6=\${RACKULA_ENABLE_IPV6:-auto}
      - NGINX_RESOLVER=\${NGINX_RESOLVER:-127.0.0.11}
      - RACKULA_TRUST_PROXY=\${RACKULA_TRUST_PROXY:-0}
    restart: unless-stopped
    stop_grace_period: 10s
    depends_on:
      rackula-api:
        condition: service_healthy

  rackula-api:
    image: ${api}
    container_name: rackula-api
    restart: unless-stopped
    stop_grace_period: 10s
    volumes:
      - ./data:/data
    environment:
      - DATA_DIR=/data
      - RACKULA_API_PORT=\${RACKULA_API_PORT:-3001}
      - CORS_ORIGIN=\${CORS_ORIGIN:-http://localhost:8080}
      - RACKULA_API_WRITE_TOKEN=\${RACKULA_API_WRITE_TOKEN:-}
      - RACKULA_AUTH_MODE=\${RACKULA_AUTH_MODE:-none}
      - ALLOW_INSECURE_CORS=\${ALLOW_INSECURE_CORS:-false}
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:\${RACKULA_API_PORT:-3001}/health"]
      interval: 30s
      timeout: 10s
      start_period: 5s
      retries: 3
    expose:
      - "\${RACKULA_API_PORT:-3001}"
`;
}

/**
 * @param {Record<string, unknown>} rackula
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(rackula, ctIp = null) {
  const parsed = parsePublicUrl(rackula);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(rackula);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} rackula
 */
export function resolveUpstreamUrl(ctIp, rackula) {
  const port = hostPort(rackula);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
