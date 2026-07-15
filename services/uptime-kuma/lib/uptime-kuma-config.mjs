import {
  UPTIME_KUMA_PASSWORD_VAULT_KEY,
  UPTIME_KUMA_USERNAME_ENV,
} from "./vault-deps.mjs";

export const DEFAULT_MONITOR_MAX_RETRIES = 3;
export const DEFAULT_MONITOR_RETRY_INTERVAL = 60;
export const DEFAULT_MONITOR_TIMEOUT = 48;
export const DEFAULT_MONITOR_ACCEPTED_STATUS_CODES = ["200-299"];

/** @typedef {{
 *   id: string;
 *   name: string;
 *   type: string;
 *   url: string | null;
 *   hostname: string | null;
 *   group: string | null;
 *   tags: string[];
 *   notifications: string[];
 *   interval: number;
 *   max_retries: number;
 *   retry_interval: number;
 *   timeout: number;
 *   accepted_status_codes: string[];
 *   ignore_tls: boolean;
 *   managed: boolean;
 *   notes: string | null;
 * }} ConfigMonitor */

/** @typedef {ConfigMonitor & {
 *   uptime_kuma_id: number;
 *   parent_uptime_kuma_id?: number | null;
 * }} LiveMonitor */

/** @typedef {{
 *   name: string;
 *   color?: string | null;
 * }} ConfigTag */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} value
 */
export function slugifyMonitorId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * @param {unknown} value
 */
export function parseUptimeKumaId(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const s = String(value ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {string} url
 */
export function shouldIgnoreTlsForUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.port === "8006") return true;
    return /^10\.\d+\.\d+\.\d+$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * @param {unknown} description
 */
export function groupFromDescription(description) {
  const m = /^Group:\s*(.+)$/.exec(String(description ?? "").trim());
  return m ? m[1].trim() : null;
}

/**
 * @param {Record<string, unknown>[]} rows
 */
export function buildMonitorByIdMap(rows) {
  /** @type {Map<number, Record<string, unknown>>} */
  const map = new Map();
  for (const row of rows) {
    const id = parseUptimeKumaId(row.id);
    if (id != null) map.set(id, row);
  }
  return map;
}

/**
 * @param {number} monitorId
 * @param {Map<number, Record<string, unknown>>} monitorById
 */
export function resolveGroupFromParent(monitorId, monitorById) {
  let current = monitorById.get(monitorId);
  const visited = new Set();
  while (current) {
    const parentId = parseUptimeKumaId(current.parent);
    if (parentId == null || visited.has(parentId)) break;
    visited.add(parentId);
    const parent = monitorById.get(parentId);
    if (!parent) break;
    if (parent.type === "group") {
      return {
        group: String(parent.name ?? "").trim(),
        parent_uptime_kuma_id: parentId,
      };
    }
    current = parent;
  }
  return { group: null, parent_uptime_kuma_id: null };
}

/**
 * @param {Record<string, unknown>} row
 */
export function tagNamesFromRow(row) {
  const tags = Array.isArray(row.tags) ? row.tags : [];
  return tags
    .map((t) => {
      if (typeof t === "string") return t.trim();
      if (isObject(t) && typeof t.name === "string") return t.name.trim();
      return "";
    })
    .filter(Boolean)
    .sort();
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {ConfigTag[]} [existingTags]
 */
export function collectTagsCatalogFromRows(rows, existingTags = []) {
  /** @type {Map<string, ConfigTag>} */
  const byName = new Map();
  for (const tag of existingTags) {
    if (typeof tag.name === "string" && tag.name.trim()) {
      byName.set(tag.name.trim().toLowerCase(), {
        name: tag.name.trim(),
        color: typeof tag.color === "string" ? tag.color : null,
      });
    }
  }
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    for (const t of tags) {
      if (!isObject(t) || typeof t.name !== "string" || !t.name.trim()) continue;
      const name = t.name.trim();
      const key = name.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, {
          name,
          color: typeof t.color === "string" ? t.color : null,
        });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {string[] | undefined | null} a
 * @param {string[] | undefined | null} b
 */
function tagsEqual(a, b) {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  if (left.length !== right.length) return false;
  return left.every((v, i) => v === right[i]);
}

/**
 * @param {ConfigMonitor} entry
 * @param {LiveMonitor[]} liveMonitors
 */
export function findLiveMonitor(entry, liveMonitors) {
  const byId = liveMonitors.find((m) => m.id === entry.id);
  if (byId) return byId;
  const key = entry.name.trim().toLowerCase();
  return liveMonitors.find((m) => m.name.trim().toLowerCase() === key) ?? null;
}

/**
 * @param {ConfigMonitor} entry
 * @param {LiveMonitor[]} liveMonitors
 */
export function configMonitorMatchesLive(entry, liveMonitors) {
  return findLiveMonitor(entry, liveMonitors) != null;
}

/**
 * @param {unknown} raw
 * @param {Record<string, unknown>} [defaults]
 * @param {Record<string, unknown>} [deployment]
 */
export function resolveUptimeKumaApiUrl(raw, defaults = {}, deployment = {}) {
  const auth = isObject(raw?.uptime_kuma_auth) ? raw.uptime_kuma_auth : {};

  const defUk = isObject(defaults.uptime_kuma) ? defaults.uptime_kuma : {};
  const depUk = isObject(deployment.uptime_kuma) ? deployment.uptime_kuma : {};
  const port =
    typeof depUk.port === "number" && Number.isFinite(depUk.port)
      ? depUk.port
      : typeof defUk.port === "number" && Number.isFinite(defUk.port)
        ? defUk.port
        : Number(depUk.port) || Number(defUk.port) || 3001;

  const configure = isObject(deployment.configure) ? deployment.configure : {};
  const ssh = isObject(configure.ssh) ? configure.ssh : {};
  const sshHost = typeof ssh.host === "string" ? ssh.host.trim() : "";
  const apiUrlRaw = typeof auth.api_url === "string" ? auth.api_url.trim() : "";
  if (apiUrlRaw) {
    if (
      sshHost &&
      (auth.api_via_ssh === true || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(apiUrlRaw))
    ) {
      return apiUrlRaw.replace(/\/$/, "");
    }
    return apiUrlRaw.replace(/\/$/, "");
  }

  if (auth.api_via_ssh === true && sshHost) {
    return `http://127.0.0.1:${port}`;
  }

  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const ipConfig = typeof lxc.ip_config === "string" ? lxc.ip_config.trim() : "";
  const ipMatch = /^(\d+\.\d+\.\d+\.\d+)/.exec(ipConfig);
  if (ipMatch) {
    return `http://${ipMatch[1]}:${port}`;
  }

  const publicUrl =
    typeof depUk.public_url === "string" && depUk.public_url.trim()
      ? depUk.public_url.trim()
      : typeof defUk.public_url === "string" && defUk.public_url.trim()
        ? defUk.public_url.trim()
        : "";
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (!u.port && port !== 443 && port !== 80) {
        u.port = String(port);
      }
      return u.origin;
    } catch {
      return publicUrl.replace(/\/$/, "");
    }
  }

  return null;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * @param {unknown} raw
 * @param {string[] | undefined} existing
 */
function normalizeAcceptedStatusCodes(raw, existing) {
  if (Array.isArray(raw)) {
    const codes = raw.filter((c) => typeof c === "string" && c.trim()).map((c) => String(c).trim());
    if (codes.length) return codes;
  }
  if (existing?.length) return existing;
  return [...DEFAULT_MONITOR_ACCEPTED_STATUS_CODES];
}

/**
 * @param {Record<string, unknown>} row
 */
export function monitorRetryFieldsFromRow(row) {
  return {
    max_retries: positiveInt(row.maxretries ?? row.max_retries, DEFAULT_MONITOR_MAX_RETRIES),
    retry_interval: positiveInt(row.retryInterval ?? row.retry_interval, DEFAULT_MONITOR_RETRY_INTERVAL),
    timeout: positiveInt(row.timeout, DEFAULT_MONITOR_TIMEOUT),
    accepted_status_codes: normalizeAcceptedStatusCodes(row.accepted_statuscodes ?? row.accepted_status_codes),
  };
}

/**
 * @param {Partial<ConfigMonitor>} entry
 */
export function resolveMonitorRetryFields(entry) {
  return {
    max_retries: positiveInt(entry.max_retries, DEFAULT_MONITOR_MAX_RETRIES),
    retry_interval: positiveInt(entry.retry_interval, DEFAULT_MONITOR_RETRY_INTERVAL),
    timeout: positiveInt(entry.timeout, DEFAULT_MONITOR_TIMEOUT),
    accepted_status_codes: normalizeAcceptedStatusCodes(entry.accepted_status_codes),
  };
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function statusCodesEqual(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * @param {unknown} raw
 */
export function normalizeUptimeKumaMonitorConfig(raw) {
  const authRaw = isObject(raw?.uptime_kuma_auth) ? raw.uptime_kuma_auth : {};

  /** @type {ConfigTag[]} */
  const tags = Array.isArray(raw?.tags)
    ? raw.tags
        .filter((t) => isObject(t) && typeof t.name === "string" && t.name.trim())
        .map((t) => ({
          name: String(t.name).trim(),
          color: typeof t.color === "string" ? t.color : null,
        }))
    : [];

  /** @type {ConfigMonitor[]} */
  const monitors = Array.isArray(raw?.monitors)
    ? raw.monitors
        .filter((m) => isObject(m) && typeof m.id === "string" && m.id.trim())
        .map((m) => ({
          id: String(m.id).trim(),
          name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : String(m.id),
          type: String(m.type ?? "http").trim(),
          url: typeof m.url === "string" && m.url.trim() ? m.url.trim() : null,
          hostname: typeof m.hostname === "string" && m.hostname.trim() ? m.hostname.trim() : null,
          group: typeof m.group === "string" && m.group.trim() ? m.group.trim() : null,
          tags: Array.isArray(m.tags)
            ? m.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => String(t).trim())
            : [],
          notifications: Array.isArray(m.notifications)
            ? m.notifications
                .filter((t) => typeof t === "string" && t.trim())
                .map((t) => String(t).trim())
            : [],
          interval: Number(m.interval ?? 60) || 60,
          ...resolveMonitorRetryFields({
            max_retries: m.max_retries,
            retry_interval: m.retry_interval,
            timeout: m.timeout,
            accepted_status_codes: m.accepted_status_codes,
          }),
          ignore_tls: m.ignore_tls === true,
          managed: m.managed === true,
          notes: typeof m.notes === "string" ? m.notes : null,
        }))
    : [];

  return {
    apiUrl: typeof authRaw.api_url === "string" && authRaw.api_url.trim() ? authRaw.api_url.trim() : null,
    usernameEnv:
      typeof authRaw.username_env === "string" && authRaw.username_env.trim()
        ? authRaw.username_env.trim()
        : UPTIME_KUMA_USERNAME_ENV,
    passwordVaultKey:
      typeof authRaw.password_vault_key === "string" && authRaw.password_vault_key.trim()
        ? authRaw.password_vault_key.trim()
        : UPTIME_KUMA_PASSWORD_VAULT_KEY,
    tags,
    monitors,
    monitorsById: new Map(monitors.map((m) => [m.id, m])),
  };
}

/**
 * @param {ConfigMonitor} cfg
 * @param {LiveMonitor} live
 */
export function monitorHasDrift(cfg, live) {
  if (cfg.name !== live.name) return true;
  if (cfg.type !== live.type) return true;
  if ((cfg.url ?? null) !== (live.url ?? null)) return true;
  if ((cfg.hostname ?? null) !== (live.hostname ?? null)) return true;
  if ((cfg.group ?? null) !== (live.group ?? null)) return true;
  if (!tagsEqual(cfg.tags, live.tags)) return true;
  if (cfg.interval !== live.interval) return true;
  if (cfg.max_retries !== live.max_retries) return true;
  if (cfg.retry_interval !== live.retry_interval) return true;
  if (cfg.timeout !== live.timeout) return true;
  if (!statusCodesEqual(cfg.accepted_status_codes, live.accepted_status_codes)) return true;
  if (cfg.ignore_tls !== live.ignore_tls) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} row
 * @param {ConfigMonitor | null} [existing]
 * @param {Map<number, Record<string, unknown>>} [monitorById]
 * @param {{ importManagedDefault?: boolean; log?: (line: string) => void }} [opts]
 * @returns {ConfigMonitor | null}
 */
export function liveMonitorRowToConfig(row, existing = null, monitorById = new Map(), opts = {}) {
  const log = opts.log ?? (() => {});
  const uptime_kuma_id = parseUptimeKumaId(row.id);
  if (uptime_kuma_id == null) return null;

  const type = typeof row.type === "string" ? row.type.trim() : "http";
  if (type === "group") return null;
  if (!["http", "ping"].includes(type)) {
    log(`skip import monitor id=${uptime_kuma_id} type=${type} (only http and ping supported)`);
    return null;
  }

  const name =
    typeof row.name === "string" && row.name.trim() ? row.name.trim() : `monitor-${uptime_kuma_id}`;

  const fromParent = resolveGroupFromParent(uptime_kuma_id, monitorById);
  const descriptionGroup = groupFromDescription(row.description);
  const group =
    existing?.group ?? fromParent.group ?? descriptionGroup ?? null;
  const rowTags = tagNamesFromRow(row);
  const tags = existing?.tags?.length ? existing.tags : rowTags;

  const importManagedDefault = opts.importManagedDefault !== false;
  const retryFields = monitorRetryFieldsFromRow(row);

  return {
    id: existing?.id ?? slugifyMonitorId(name),
    name,
    type,
    url: typeof row.url === "string" && row.url.trim() ? row.url.trim() : null,
    hostname: typeof row.hostname === "string" && row.hostname.trim() ? row.hostname.trim() : null,
    group,
    tags,
    interval: Number(row.interval ?? 60) || 60,
    ...resolveMonitorRetryFields({
      max_retries: existing?.max_retries ?? retryFields.max_retries,
      retry_interval: existing?.retry_interval ?? retryFields.retry_interval,
      timeout: existing?.timeout ?? retryFields.timeout,
      accepted_status_codes: existing?.accepted_status_codes ?? retryFields.accepted_status_codes,
    }),
    ignore_tls: row.ignoreTls === true || row.ignore_tls === true,
    managed: existing?.managed ?? (importManagedDefault ? true : false),
    notes: existing?.notes ?? null,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {ConfigMonitor | null} [existing]
 * @param {Map<number, Record<string, unknown>>} [monitorById]
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {LiveMonitor | null}
 */
export function liveMonitorRowToLive(row, existing = null, monitorById = new Map(), opts = {}) {
  const cfg = liveMonitorRowToConfig(row, existing, monitorById, opts);
  if (!cfg) return null;
  const uptime_kuma_id = parseUptimeKumaId(row.id);
  if (uptime_kuma_id == null) return null;
  const fromParent = resolveGroupFromParent(uptime_kuma_id, monitorById);
  return {
    ...cfg,
    uptime_kuma_id,
    parent_uptime_kuma_id: fromParent.parent_uptime_kuma_id,
  };
}

/**
 * @param {string} name
 * @param {boolean} [forEdit]
 * @param {number | null} [id]
 */
export function groupMonitorToSocketPayload(name, forEdit = false, id = null) {
  const retryFields = resolveMonitorRetryFields({});
  /** @type {Record<string, unknown>} */
  const payload = {
    type: "group",
    name,
    interval: 60,
    retryInterval: retryFields.retry_interval,
    maxretries: retryFields.max_retries,
    resendInterval: 0,
    upsideDown: false,
    notificationIDList: {},
    active: true,
    description: "",
    conditions: [],
    accepted_statuscodes: ["200-299"],
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: { mechanism: "None" },
    rabbitmqNodes: [],
    dns_resolve_type: "A",
    dns_resolve_server: "1.1.1.1",
  };
  if (forEdit && id != null) payload.id = id;
  return payload;
}

/**
 * @param {ConfigMonitor} entry
 * @param {boolean} [forEdit]
 * @param {{ parentId?: number | null; liveId?: number | null; notificationIDList?: Record<string, boolean> }} [opts]
 */
export function monitorToSocketPayload(entry, forEdit = false, opts = {}) {
  const retryFields = resolveMonitorRetryFields(entry);
  /** @type {Record<string, unknown>} */
  const payload = {
    type: entry.type,
    name: entry.name,
    interval: entry.interval,
    retryInterval: retryFields.retry_interval,
    maxretries: retryFields.max_retries,
    resendInterval: 0,
    upsideDown: false,
    notificationIDList: opts.notificationIDList ?? {},
    active: true,
    description: entry.notes ?? "",
    httpBodyEncoding: "json",
    conditions: [],
    accepted_statuscodes: retryFields.accepted_status_codes,
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: { mechanism: "None" },
    rabbitmqNodes: [],
    dns_resolve_type: "A",
    dns_resolve_server: "1.1.1.1",
  };

  if (forEdit && opts.liveId != null) {
    payload.id = opts.liveId;
  }

  if (opts.parentId != null) {
    payload.parent = opts.parentId;
  }

  if (entry.type === "http") {
    payload.url = entry.url ?? "";
    payload.method = "GET";
    payload.maxredirects = 10;
    payload.ignoreTls = entry.ignore_tls === true;
    payload.expiryNotification = false;
    payload.authMethod = "";
    payload.timeout = retryFields.timeout;
  } else if (entry.type === "ping") {
    payload.hostname = entry.hostname ?? "";
    payload.packetSize = 56;
  }

  return payload;
}

/**
 * @param {ConfigMonitor} entry
 */
export function validateConfigMonitor(entry) {
  if (!entry.id) throw new Error("monitor id is required");
  if (!entry.name) throw new Error(`monitor ${entry.id}: name is required`);
  if (entry.type === "http" && !entry.url) {
    throw new Error(`monitor ${entry.id}: url is required for type http`);
  }
  if (entry.type === "ping" && !entry.hostname) {
    throw new Error(`monitor ${entry.id}: hostname is required for type ping`);
  }
  if (!["http", "ping"].includes(entry.type)) {
    throw new Error(`monitor ${entry.id}: unsupported type ${entry.type}`);
  }
}
