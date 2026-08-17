/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} apprise
 */
export function normalizeImageTag(apprise) {
  const t = typeof apprise.image_tag === "string" ? apprise.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} apprise
 */
export function hostPort(apprise) {
  const p = typeof apprise.host_port === "number" ? apprise.host_port : Number(apprise.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8000;
}

/**
 * @param {Record<string, unknown>} apprise
 */
export function normalizeTimezone(apprise) {
  const tz = typeof apprise.timezone === "string" ? apprise.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} apprise
 */
export function workerCount(apprise) {
  const n = typeof apprise.worker_count === "number" ? apprise.worker_count : Number(apprise.worker_count);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return 1;
}

/**
 * @param {Record<string, unknown>} apprise
 */
export function adminEnabled(apprise) {
  return apprise.admin !== false && apprise.admin !== 0 && apprise.admin !== "n";
}

/**
 * @param {Record<string, unknown>} apprise
 */
export function statefulMode(apprise) {
  const m = typeof apprise.stateful_mode === "string" ? apprise.stateful_mode.trim() : "";
  return m || "simple";
}

/**
 * @param {Record<string, unknown>} apprise
 * @returns {URL | null}
 */
export function parsePublicUrl(apprise) {
  const raw = apprise.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`apprise.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("apprise.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/apprise";
}

/**
 * @param {Record<string, unknown>} install
 */
export function dataDirs(install) {
  const dir = composeDir(install);
  return {
    config: `${dir}/config`,
    plugin: `${dir}/plugin`,
    attach: `${dir}/attach`,
  };
}

/**
 * Build a passwordless mailto:// URL for the internal postfix-relay.
 *
 * @param {{ host: string; port?: number; from: string; to?: string }} relay
 */
export function buildMailtoUrl(relay) {
  const host = typeof relay.host === "string" ? relay.host.trim() : "";
  if (!host) throw new Error("mailto URL requires relay.host");
  const from = typeof relay.from === "string" ? relay.from.trim() : "";
  if (!from) throw new Error("mailto URL requires relay.from");
  const to = typeof relay.to === "string" && relay.to.trim() ? relay.to.trim() : from;
  const port = Number(relay.port);
  const portPart = Number.isFinite(port) && port > 0 && port !== 25 ? `:${Math.floor(port)}` : "";
  const q = new URLSearchParams({ from, to });
  return `mailto://${host}${portPart}/?${q.toString()}`;
}

/**
 * @param {Record<string, unknown>} apprise
 * @param {{ host: string; port?: number; from: string }} relay
 * @returns {string | null}
 */
export function appriseMailtoUrl(apprise, relay) {
  const mail = isObject(apprise.mail) ? apprise.mail : {};
  if (mail.enabled === false || mail.enabled === 0 || mail.enabled === "false") return null;
  const from =
    typeof mail.from === "string" && mail.from.trim() ? mail.from.trim() : relay.from;
  const to = typeof mail.to === "string" && mail.to.trim() ? mail.to.trim() : from;
  return buildMailtoUrl({ host: relay.host, port: relay.port, from, to });
}

/**
 * @param {unknown} raw
 * @returns {{ id: string; urls: string[] }[]}
 */
function normalizeKeys(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [{ id: "ha", urls: [] }];
  }
  /** @type {{ id: string; urls: string[] }[]} */
  const out = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({ id: item.trim(), urls: [] });
      continue;
    }
    if (!isObject(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const urls = Array.isArray(item.urls)
      ? item.urls.map((u) => String(u).trim()).filter(Boolean)
      : typeof item.urls === "string" && item.urls.trim()
        ? item.urls.split(/[\s,]+/).filter(Boolean)
        : [];
    out.push({ id, urls });
  }
  return out.length ? out : [{ id: "ha", urls: [] }];
}

/**
 * @param {Record<string, unknown>} apprise
 * @param {{ host: string; port?: number; from: string }} relay
 * @returns {{ id: string; urls: string[] }[]}
 */
export function resolveAppriseKeys(apprise, relay) {
  const keys = normalizeKeys(apprise.keys);
  const mailto = appriseMailtoUrl(apprise, relay);
  return keys.map((k) => {
    const urls = k.urls.length ? k.urls : mailto ? [mailto] : [];
    return { id: k.id, urls };
  });
}

/**
 * @param {Record<string, unknown>} apprise
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(apprise, install) {
  const tag = normalizeImageTag(apprise);
  const port = hostPort(apprise);
  const tz = normalizeTimezone(apprise).replace(/'/g, "''");
  const dir = composeDir(install).replace(/'/g, "''");
  const workers = workerCount(apprise);
  const admin = adminEnabled(apprise) ? "y" : "n";
  const mode = statefulMode(apprise).replace(/'/g, "''");
  return `services:
  apprise:
    container_name: apprise
    image: caronc/apprise:${tag}
    restart: unless-stopped
    ports:
      - "${port}:8000/tcp"
    environment:
      TZ: '${tz}'
      APPRISE_STATEFUL_MODE: '${mode}'
      APPRISE_WORKER_COUNT: '${workers}'
      APPRISE_ADMIN: '${admin}'
      ALLOWED_HOSTS: '*'
    volumes:
      - '${dir}/config:/config'
      - '${dir}/plugin:/plugin'
      - '${dir}/attach:/attach'
`;
}

/**
 * @param {Record<string, unknown>} apprise
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(apprise, ctIp = null) {
  const parsed = parsePublicUrl(apprise);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(apprise);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} apprise
 */
export function resolveUpstreamUrl(ctIp, apprise) {
  const port = hostPort(apprise);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
