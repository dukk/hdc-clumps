/**
 * @param {Record<string, unknown>} itTools
 */
export function normalizeImage(itTools) {
  const img = typeof itTools.image === "string" ? itTools.image.trim() : "";
  if (!img) return "corentinth/it-tools:latest";
  return img;
}

/**
 * @param {Record<string, unknown>} itTools
 */
export function hostPort(itTools) {
  const p =
    typeof itTools.host_port === "number" ? itTools.host_port : Number(itTools.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8080;
}

/**
 * @param {Record<string, unknown>} itTools
 * @returns {URL | null}
 */
export function parsePublicUrl(itTools) {
  const raw = itTools.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`it_tools.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("it_tools.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/it-tools";
}

/**
 * @param {Record<string, unknown>} itTools
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(itTools, install) {
  const image = normalizeImage(itTools).replace(/'/g, "''");
  const port = hostPort(itTools);
  return `services:
  it-tools:
    container_name: it-tools
    image: ${image}
    restart: unless-stopped
    ports:
      - "${port}:80"
`;
}

/**
 * @param {Record<string, unknown>} itTools
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(itTools, ctIp = null) {
  const parsed = parsePublicUrl(itTools);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(itTools);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} itTools
 */
export function resolveUpstreamUrl(ctIp, itTools) {
  const port = hostPort(itTools);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
