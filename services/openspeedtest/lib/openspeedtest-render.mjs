/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} openspeedtest
 */
export function normalizeImage(openspeedtest) {
  const img = typeof openspeedtest.image === "string" ? openspeedtest.image.trim() : "";
  if (!img) return "openspeedtest/latest";
  return img;
}

/**
 * @param {Record<string, unknown>} openspeedtest
 */
export function hostPort(openspeedtest) {
  const p =
    typeof openspeedtest.host_port === "number"
      ? openspeedtest.host_port
      : Number(openspeedtest.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3000;
}

/**
 * @param {Record<string, unknown>} openspeedtest
 */
export function normalizeTimezone(openspeedtest) {
  const tz = typeof openspeedtest.timezone === "string" ? openspeedtest.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} openspeedtest
 * @returns {URL | null}
 */
export function parsePublicUrl(openspeedtest) {
  const raw = openspeedtest.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`openspeedtest.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("openspeedtest.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/openspeedtest";
}

/**
 * @param {Record<string, unknown>} openspeedtest
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(openspeedtest, install) {
  const image = normalizeImage(openspeedtest).replace(/'/g, "''");
  const port = hostPort(openspeedtest);
  const tz = normalizeTimezone(openspeedtest).replace(/'/g, "''");
  return `services:
  speedtest:
    container_name: openspeedtest
    image: ${image}
    restart: unless-stopped
    ports:
      - "${port}:3000/tcp"
    environment:
      TZ: '${tz}'
`;
}

/**
 * @param {Record<string, unknown>} openspeedtest
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(openspeedtest, ctIp = null) {
  const parsed = parsePublicUrl(openspeedtest);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(openspeedtest);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} openspeedtest
 */
export function resolveUpstreamUrl(ctIp, openspeedtest) {
  const port = hostPort(openspeedtest);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
