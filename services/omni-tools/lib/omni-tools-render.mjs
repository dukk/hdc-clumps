/**
 * @param {Record<string, unknown>} OmniTools
 */
export function normalizeImage(OmniTools) {
  const img = typeof OmniTools.image === "string" ? OmniTools.image.trim() : "";
  if (!img) return "iib0011/omni-tools:latest";
  return img;
}

/**
 * @param {Record<string, unknown>} OmniTools
 */
export function hostPort(OmniTools) {
  const p =
    typeof OmniTools.host_port === "number" ? OmniTools.host_port : Number(OmniTools.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8080;
}

/**
 * @param {Record<string, unknown>} OmniTools
 * @returns {URL | null}
 */
export function parsePublicUrl(OmniTools) {
  const raw = OmniTools.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`omni_tools.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("omni_tools.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/omni-tools";
}

/**
 * @param {Record<string, unknown>} OmniTools
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(OmniTools, install) {
  const image = normalizeImage(OmniTools).replace(/'/g, "''");
  const port = hostPort(OmniTools);
  return `services:
  omni-tools:
    container_name: omni-tools
    image: ${image}
    restart: unless-stopped
    ports:
      - "${port}:80"
`;
}

/**
 * @param {Record<string, unknown>} OmniTools
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(OmniTools, ctIp = null) {
  const parsed = parsePublicUrl(OmniTools);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(OmniTools);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} OmniTools
 */
export function resolveUpstreamUrl(ctIp, OmniTools) {
  const port = hostPort(OmniTools);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
