/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} memos
 */
export function normalizeImageTag(memos) {
  const t = typeof memos.image_tag === "string" ? memos.image_tag.trim() : "";
  if (!t) return "stable";
  return t;
}

/**
 * @param {Record<string, unknown>} memos
 */
export function hostPort(memos) {
  const p = typeof memos.host_port === "number" ? memos.host_port : Number(memos.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 5230;
}

/**
 * @param {Record<string, unknown>} memos
 */
export function normalizeDriver(memos) {
  const d = typeof memos.driver === "string" ? memos.driver.trim().toLowerCase() : "";
  if (!d) return "sqlite";
  return d;
}

/**
 * @param {Record<string, unknown>} memos
 * @returns {URL | null}
 */
export function parsePublicUrl(memos) {
  const raw = memos.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`memos.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("memos.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/memos";
}

/**
 * @param {Record<string, unknown>} memos
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(memos, install) {
  const tag = normalizeImageTag(memos);
  const port = hostPort(memos);
  const driver = normalizeDriver(memos);
  const dir = composeDir(install).replace(/'/g, "''");
  const parsed = parsePublicUrl(memos);
  const instanceUrl = parsed ? parsed.origin.replace(/\/+$/, "") : null;

  const envLines = [
    "      MEMOS_PORT: 5230",
    `      MEMOS_DRIVER: ${driver}`,
  ];
  if (instanceUrl) {
    envLines.push(`      MEMOS_INSTANCE_URL: '${instanceUrl.replace(/'/g, "''")}'`);
  }

  return `services:
  memos:
    container_name: memos
    image: neosmemo/memos:${tag}
    restart: unless-stopped
    ports:
      - "${port}:5230"
    volumes:
      - '${dir}/data:/var/opt/memos'
    environment:
${envLines.join("\n")}
`;
}

/**
 * @param {Record<string, unknown>} memos
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(memos, ctIp = null) {
  const parsed = parsePublicUrl(memos);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(memos);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} memos
 */
export function resolveUpstreamUrl(ctIp, memos) {
  const port = hostPort(memos);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {Record<string, unknown>} install
 */
export function dataDir(install) {
  const dir = composeDir(install);
  return `${dir}/data`;
}
