/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} wallos
 */
export function normalizeImageTag(wallos) {
  const t = typeof wallos.image_tag === "string" ? wallos.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} wallos
 */
export function hostPort(wallos) {
  const p = typeof wallos.host_port === "number" ? wallos.host_port : Number(wallos.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8282;
}

/**
 * @param {Record<string, unknown>} wallos
 */
export function normalizeTimezone(wallos) {
  const tz = typeof wallos.timezone === "string" ? wallos.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} wallos
 * @returns {URL | null}
 */
export function parsePublicUrl(wallos) {
  const raw = wallos.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`wallos.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("wallos.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/wallos";
}

/**
 * @param {Record<string, unknown>} wallos
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(wallos, install) {
  const tag = normalizeImageTag(wallos);
  const port = hostPort(wallos);
  const tz = normalizeTimezone(wallos).replace(/'/g, "''");
  const dir = composeDir(install).replace(/'/g, "''");
  return `services:
  wallos:
    container_name: wallos
    image: bellamy/wallos:${tag}
    restart: unless-stopped
    ports:
      - "${port}:80/tcp"
    environment:
      TZ: '${tz}'
    volumes:
      - '${dir}/db:/var/www/html/db'
      - '${dir}/logos:/var/www/html/images/uploads/logos'
`;
}

/**
 * @param {Record<string, unknown>} wallos
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(wallos, ctIp = null) {
  const parsed = parsePublicUrl(wallos);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(wallos);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} wallos
 */
export function resolveUpstreamUrl(ctIp, wallos) {
  const port = hostPort(wallos);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {Record<string, unknown>} wallos
 * @param {Record<string, unknown>} install
 */
export function dataDirs(install) {
  const dir = composeDir(install);
  return { db: `${dir}/db`, logos: `${dir}/logos` };
}
