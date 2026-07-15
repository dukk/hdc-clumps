import { httpPort, httpsPort } from "./deployments.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} yacy
 */
export function normalizeImageTag(yacy) {
  const t = typeof yacy.image_tag === "string" ? yacy.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} yacy
 */
export function peerName(yacy) {
  const n = typeof yacy.peer_name === "string" ? yacy.peer_name.trim() : "";
  return n || "yacy-peer";
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/yacy";
}

/**
 * @param {Record<string, unknown>} yacy
 */
export function adminPasswordVaultKey(yacy) {
  const key =
    typeof yacy.admin_password_vault_key === "string" && yacy.admin_password_vault_key.trim()
      ? yacy.admin_password_vault_key.trim()
      : "HDC_YACY_ADMIN_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} yacy
 */
export function renderYacyEnv(yacy) {
  const tag = normalizeImageTag(yacy);
  const http = httpPort(yacy);
  const https = httpsPort(yacy);
  const peer = peerName(yacy);
  const lines = [
    "# hdc-generated — docker compose",
    `YACY_IMAGE_TAG=${tag}`,
    `YACY_HTTP_PORT=${http}`,
    `YACY_HTTPS_PORT=${https}`,
    `YACY_PEER_NAME=${peer}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  yacy:
    image: yacy/yacy_search_server:\${YACY_IMAGE_TAG}
    container_name: yacy
    restart: unless-stopped
    ports:
      - "\${YACY_HTTP_PORT}:8090"
      - "\${YACY_HTTPS_PORT}:8443"
    environment:
      YACY_NETWORK_UNIT_AGENT: \${YACY_PEER_NAME}
    volumes:
      - yacy-data:/opt/yacy_search_server/DATA
    logging:
      options:
        max-size: "200m"
        max-file: "2"

volumes:
  yacy-data: {}
`;
}

/**
 * @param {Record<string, unknown>} yacy
 * @param {string | null} ctIp
 */
export function resolvePublicUrl(yacy, ctIp) {
  const configured =
    typeof yacy.public_url === "string" && yacy.public_url.trim() ? yacy.public_url.trim() : null;
  if (configured) return configured;
  const port = httpPort(yacy);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} yacy
 */
export function resolveUiUrl(ctIp, yacy) {
  return resolvePublicUrl(isObject(yacy) ? yacy : {}, ctIp);
}
