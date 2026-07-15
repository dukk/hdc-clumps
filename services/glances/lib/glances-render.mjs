/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} glances
 */
export function normalizeImage(glances) {
  const img = typeof glances.image === "string" ? glances.image.trim() : "";
  if (!img) return "nicolargo/glances:latest-full";
  return img;
}

/**
 * @param {Record<string, unknown>} glances
 */
export function hostPort(glances) {
  const p =
    typeof glances.host_port === "number" ? glances.host_port : Number(glances.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 61208;
}

/**
 * @param {Record<string, unknown>} glances
 */
export function normalizeTimezone(glances) {
  const tz = typeof glances.timezone === "string" ? glances.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} glances
 */
export function glancesOpt(glances) {
  const base = "-w";
  if (glances.browser_mode === true) return `${base} --browser`;
  return base;
}

/**
 * @param {Record<string, unknown>} glances
 * @returns {URL | null}
 */
export function parsePublicUrl(glances) {
  const raw = glances.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`glances.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("glances.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/glances";
}

/**
 * @param {Record<string, unknown>} glances
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(glances, install) {
  const image = normalizeImage(glances).replace(/'/g, "''");
  const port = hostPort(glances);
  const secondaryPort = port + 1;
  const tz = normalizeTimezone(glances).replace(/'/g, "''");
  const opt = glancesOpt(glances).replace(/'/g, "''");
  return `services:
  glances:
    container_name: glances
    image: ${image}
    restart: unless-stopped
    pid: host
    ports:
      - "${port}:61208"
      - "${secondaryPort}:61209"
    environment:
      TZ: '${tz}'
      GLANCES_OPT: '${opt}'
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
`;
}

/**
 * @param {Record<string, unknown>} glances
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(glances, ctIp = null) {
  const parsed = parsePublicUrl(glances);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(glances);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} glances
 */
export function resolveUpstreamUrl(ctIp, glances) {
  const port = hostPort(glances);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
