/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** RustDesk OSS minimum ports for LAN clients. */
export const REQUIRED_PORTS = {
  tcp: [21115, 21116, 21117, 21118, 21119],
  udp: [21116],
  relay_port: 21117,
};

/**
 * @param {Record<string, unknown>} rustdesk
 */
export function normalizeImageTag(rustdesk) {
  const t = typeof rustdesk.image_tag === "string" ? rustdesk.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} rustdesk
 */
export function alwaysUseRelay(rustdesk) {
  return rustdesk.always_use_relay === true;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/rustdesk";
}

/**
 * @param {Record<string, unknown>} install
 */
export function dataDir(install) {
  return `${composeDir(install)}/data`;
}

/**
 * @param {Record<string, unknown>} rustdesk
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(rustdesk, install) {
  const tag = normalizeImageTag(rustdesk);
  const dir = composeDir(install).replace(/'/g, "''");
  const data = dataDir(install).replace(/'/g, "''");
  const relayEnv = alwaysUseRelay(rustdesk)
    ? `    environment:
      - ALWAYS_USE_RELAY=Y
`
    : "";

  return `services:
  hbbr:
    container_name: hbbr
    image: rustdesk/rustdesk-server:${tag}
    command: hbbr
    volumes:
      - '${data}:/root'
    network_mode: host
    restart: unless-stopped

  hbbs:
    container_name: hbbs
    image: rustdesk/rustdesk-server:${tag}
    command: hbbs
${relayEnv}    volumes:
      - '${data}:/root'
    network_mode: host
    depends_on:
      - hbbr
    restart: unless-stopped
`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} rustdesk
 */
export function resolveIdServerHost(ctIp, rustdesk) {
  const override =
    typeof rustdesk.id_server_host === "string" ? rustdesk.id_server_host.trim() : "";
  if (override) return override;
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  return ip || null;
}

/**
 * @param {string | null} ctIp
 * @param {string | null} publicKey
 * @param {Record<string, unknown>} rustdesk
 */
export function clientConfigSummary(ctIp, publicKey, rustdesk) {
  const idServer = resolveIdServerHost(ctIp, rustdesk);
  const key = typeof publicKey === "string" ? publicKey.trim() : "";
  return {
    id_server: idServer,
    public_key: key || null,
    relay_server: null,
    api_server: null,
    relay_port: REQUIRED_PORTS.relay_port,
    ports: REQUIRED_PORTS,
    client_hint:
      "RustDesk client: Settings → Network → ID/Relay server — set ID server and Key; leave relay/API blank for OSS.",
  };
}
