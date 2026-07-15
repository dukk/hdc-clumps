/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} nextcloud
 */
export function normalizeAioBlock(nextcloud) {
  const aio = isObject(nextcloud.aio) ? nextcloud.aio : {};
  const channel =
    typeof aio.image_channel === "string" && aio.image_channel.trim()
      ? aio.image_channel.trim().toLowerCase()
      : "latest";
  const imageTag = channel === "beta" ? "beta" : "latest";
  const interfaceHostPort = interfaceHostPortFromAio(aio);
  const rp = isObject(aio.reverse_proxy) ? aio.reverse_proxy : {};
  const reverseProxyEnabled = rp.enabled === true;
  const domain =
    typeof rp.domain === "string" && rp.domain.trim() ? rp.domain.trim() : null;
  const apachePort =
    typeof rp.apache_port === "number" && Number.isFinite(rp.apache_port)
      ? Math.floor(rp.apache_port)
      : Number(rp.apache_port) || 11000;
  return {
    imageTag,
    interfaceHostPort,
    reverseProxyEnabled,
    domain,
    apachePort,
  };
}

/**
 * @param {Record<string, unknown>} aio
 */
function interfaceHostPortFromAio(aio) {
  const p =
    typeof aio.interface_host_port === "number"
      ? aio.interface_host_port
      : Number(aio.interface_host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8080;
}

/**
 * GitHub raw URL for upstream compose.yaml (reference / optional fetch).
 * @param {string} channel `latest` or `beta`
 */
export function composeFileUrl(channel) {
  const c = channel === "beta" ? "beta" : "latest";
  const branch = "main";
  return `https://raw.githubusercontent.com/nextcloud/all-in-one/${branch}/compose.yaml`;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/nextcloud-aio";
}

/**
 * Render AIO mastercontainer compose.yaml (fixed names per Nextcloud AIO requirements).
 * @param {Record<string, unknown>} nextcloud
 */
export function renderComposeYaml(nextcloud) {
  const { imageTag, interfaceHostPort, reverseProxyEnabled, apachePort } =
    normalizeAioBlock(nextcloud);

  /** @type {string[]} */
  const portLines = [`      - "${interfaceHostPort}:8080"`];
  if (!reverseProxyEnabled) {
    portLines.unshift('      - "80:80"');
    portLines.push('      - "8443:8443"');
  }

  /** @type {string[]} */
  const envLines = [];
  if (reverseProxyEnabled) {
    envLines.push("    environment:");
    envLines.push(`      APACHE_PORT: ${apachePort}`);
    envLines.push("      APACHE_IP_BINDING: 127.0.0.1");
  }

  const envBlock = envLines.length ? `${envLines.join("\n")}\n` : "";

  return [
    "# hdc-generated — Nextcloud All-in-One mastercontainer",
    "name: nextcloud-aio",
    "services:",
    "  nextcloud-aio-mastercontainer:",
    `    image: ghcr.io/nextcloud-releases/all-in-one:${imageTag}`,
    "    init: true",
    "    restart: always",
    "    container_name: nextcloud-aio-mastercontainer",
    "    volumes:",
    "      - nextcloud_aio_mastercontainer:/mnt/docker-aio-config",
    "      - /var/run/docker.sock:/var/run/docker.sock:ro",
    "    network_mode: bridge",
    "    ports:",
    ...portLines,
    envBlock.trimEnd() ? envBlock.trimEnd() : null,
    "",
    "volumes:",
    "  nextcloud_aio_mastercontainer:",
    "    name: nextcloud_aio_mastercontainer",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} nextcloud
 */
export function resolveAioInterfaceUrl(ctIp, nextcloud) {
  const { interfaceHostPort } = normalizeAioBlock(nextcloud);
  if (!ctIp) return null;
  return `https://${ctIp}:${interfaceHostPort}`;
}
