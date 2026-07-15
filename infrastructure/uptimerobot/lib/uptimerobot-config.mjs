import { UPTIMEROBOT_API_KEY_VAULT_KEY } from "./vault-deps.mjs";

/** @typedef {{
 *   email: string | null;
 *   monitor_limit: number | null;
 *   monitor_interval: number | null;
 *   up_monitors: number | null;
 *   down_monitors: number | null;
 *   pause_monitors: number | null;
 * }} ConfigAccountSummary */

/** @typedef {{
 *   contact_id: string;
 *   threshold: number;
 *   recurrence: number;
 * }} ConfigMonitorAlertContact */

/** @typedef {{
 *   id: string;
 *   uptimerobot_id: number;
 *   friendly_name: string;
 *   type: string;
 *   url: string | null;
 *   interval_seconds: number;
 *   status: string;
 *   managed: boolean;
 *   notes: string | null;
 *   alert_contacts: ConfigMonitorAlertContact[];
 *   options: Record<string, unknown>;
 * }} ConfigMonitor */

/** @typedef {{
 *   id: string;
 *   uptimerobot_id: number;
 *   friendly_name: string;
 *   type: string;
 *   value: string | null;
 *   status: string;
 *   managed: boolean;
 *   notes: string | null;
 * }} ConfigAlertContact */

/** @typedef {{
 *   id: string;
 *   uptimerobot_id: number;
 *   friendly_name: string;
 *   standard_url: string | null;
 *   custom_url: string | null;
 *   monitors: "all" | string[];
 *   sort: string;
 *   status: string;
 *   managed: boolean;
 *   notes: string | null;
 * }} ConfigStatusPage */

const MONITOR_TYPE_TO_API = {
  http: 1,
  keyword: 2,
  ping: 3,
  port: 4,
  heartbeat: 5,
};

const MONITOR_TYPE_FROM_API = Object.fromEntries(
  Object.entries(MONITOR_TYPE_TO_API).map(([k, v]) => [String(v), k])
);

const MONITOR_STATUS_TO_API = {
  paused: 0,
  not_checked: 1,
  up: 2,
  seems_down: 8,
  down: 9,
};

const MONITOR_STATUS_FROM_API = Object.fromEntries(
  Object.entries(MONITOR_STATUS_TO_API).map(([k, v]) => [String(v), k])
);

const PSP_SORT_TO_API = {
  name_asc: 1,
  name_desc: 2,
  status_up_down: 3,
  status_down_up: 4,
};

const PSP_SORT_FROM_API = Object.fromEntries(
  Object.entries(PSP_SORT_TO_API).map(([k, v]) => [String(v), k])
);

const PSP_STATUS_TO_API = {
  paused: 0,
  active: 1,
};

const PSP_STATUS_FROM_API = Object.fromEntries(
  Object.entries(PSP_STATUS_TO_API).map(([k, v]) => [String(v), k])
);

const ALERT_CONTACT_TYPE_TO_API = {
  sms: 1,
  email: 2,
  twitter: 3,
  webhook: 5,
  pushbullet: 6,
  zapier: 7,
  pro_sms: 8,
  pushover: 9,
  slack: 11,
  voice_call: 14,
  splunk: 15,
  pagerduty: 16,
  opsgenie: 17,
  ms_teams: 20,
  google_chat: 21,
  discord: 23,
};

const ALERT_CONTACT_TYPE_FROM_API = Object.fromEntries(
  Object.entries(ALERT_CONTACT_TYPE_TO_API).map(([k, v]) => [String(v), k])
);

const ALERT_CONTACT_STATUS_TO_API = {
  not_activated: 0,
  paused: 1,
  active: 2,
};

const ALERT_CONTACT_STATUS_FROM_API = Object.fromEntries(
  Object.entries(ALERT_CONTACT_STATUS_TO_API).map(([k, v]) => [String(v), k])
);

const PORT_SUB_TYPE_TO_API = {
  http: 1,
  https: 2,
  ftp: 3,
  smtp: 4,
  pop3: 5,
  imap: 6,
  custom: 99,
};

const PORT_SUB_TYPE_FROM_API = Object.fromEntries(
  Object.entries(PORT_SUB_TYPE_TO_API).map(([k, v]) => [String(v), k])
);

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} value
 */
export function slugifyId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * @param {string} prefix
 * @param {number} uptimerobotId
 * @param {string} [friendlyName]
 * @param {Set<string>} [usedIds]
 */
export function deriveResourceId(prefix, uptimerobotId, friendlyName, usedIds = new Set()) {
  const fromName = slugifyId(friendlyName ?? "");
  let base = fromName || `${prefix}-${uptimerobotId}`;
  if (!base) base = `${prefix}-${uptimerobotId}`;
  let candidate = base;
  let n = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

/**
 * @param {unknown} value
 */
export function parseUptimerobotId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string | number | undefined | null} apiType
 */
export function monitorTypeFromApi(apiType) {
  const key = String(apiType ?? "").trim();
  return MONITOR_TYPE_FROM_API[key] ?? (key ? `type_${key}` : "http");
}

/**
 * @param {string} configType
 */
export function monitorTypeToApi(configType) {
  const key = String(configType ?? "").trim();
  if (MONITOR_TYPE_TO_API[/** @type {keyof typeof MONITOR_TYPE_TO_API} */ (key)] != null) {
    return MONITOR_TYPE_TO_API[/** @type {keyof typeof MONITOR_TYPE_TO_API} */ (key)];
  }
  const m = /^type_(\d+)$/.exec(key);
  if (m) return Number(m[1]);
  throw new Error(`Unknown monitor type: ${configType}`);
}

/**
 * @param {string | number | undefined | null} apiStatus
 */
export function monitorStatusFromApi(apiStatus) {
  const key = String(apiStatus ?? "").trim();
  return MONITOR_STATUS_FROM_API[key] ?? (key ? `status_${key}` : "not_checked");
}

/**
 * @param {string} configStatus
 */
export function monitorStatusToApi(configStatus) {
  const key = String(configStatus ?? "").trim();
  if (MONITOR_STATUS_TO_API[/** @type {keyof typeof MONITOR_STATUS_TO_API} */ (key)] != null) {
    return MONITOR_STATUS_TO_API[/** @type {keyof typeof MONITOR_STATUS_TO_API} */ (key)];
  }
  const m = /^status_(\d+)$/.exec(key);
  if (m) return Number(m[1]);
  throw new Error(`Unknown monitor status: ${configStatus}`);
}

/**
 * @param {string | number | undefined | null} apiSort
 */
export function pspSortFromApi(apiSort) {
  const key = String(apiSort ?? "").trim();
  return PSP_SORT_FROM_API[key] ?? "name_asc";
}

/**
 * @param {string} configSort
 */
export function pspSortToApi(configSort) {
  const key = String(configSort ?? "").trim();
  return PSP_SORT_TO_API[/** @type {keyof typeof PSP_SORT_TO_API} */ (key)] ?? 1;
}

/**
 * @param {string | number | undefined | null} apiStatus
 */
export function pspStatusFromApi(apiStatus) {
  const key = String(apiStatus ?? "").trim();
  return PSP_STATUS_FROM_API[key] ?? "active";
}

/**
 * @param {string} configStatus
 */
export function pspStatusToApi(configStatus) {
  const key = String(configStatus ?? "").trim();
  return PSP_STATUS_TO_API[/** @type {keyof typeof PSP_STATUS_TO_API} */ (key)] ?? 1;
}

/**
 * @param {string | number | undefined | null} apiType
 */
export function alertContactTypeFromApi(apiType) {
  const key = String(apiType ?? "").trim();
  return ALERT_CONTACT_TYPE_FROM_API[key] ?? (key ? `type_${key}` : "email");
}

/**
 * @param {string} configType
 */
export function alertContactTypeToApi(configType) {
  const key = String(configType ?? "").trim();
  if (
    ALERT_CONTACT_TYPE_TO_API[/** @type {keyof typeof ALERT_CONTACT_TYPE_TO_API} */ (key)] != null
  ) {
    return ALERT_CONTACT_TYPE_TO_API[/** @type {keyof typeof ALERT_CONTACT_TYPE_TO_API} */ (key)];
  }
  const m = /^type_(\d+)$/.exec(key);
  if (m) return Number(m[1]);
  throw new Error(`Unknown alert contact type: ${configType}`);
}

/**
 * @param {string | number | undefined | null} apiStatus
 */
export function alertContactStatusFromApi(apiStatus) {
  const key = String(apiStatus ?? "").trim();
  return ALERT_CONTACT_STATUS_FROM_API[key] ?? "not_activated";
}

/**
 * @param {string} configStatus
 */
export function alertContactStatusToApi(configStatus) {
  const key = String(configStatus ?? "").trim();
  return (
    ALERT_CONTACT_STATUS_TO_API[/** @type {keyof typeof ALERT_CONTACT_STATUS_TO_API} */ (key)] ?? 0
  );
}

/**
 * @param {unknown} raw
 * @param {Map<number, string>} contactIdByUptimerobotId
 * @returns {ConfigMonitorAlertContact[]}
 */
export function parseMonitorAlertContacts(raw, contactIdByUptimerobotId) {
  /** @type {ConfigMonitorAlertContact[]} */
  const out = [];

  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!isObject(row)) continue;
      const urId = parseUptimerobotId(row.id);
      if (urId == null) continue;
      const contact_id = contactIdByUptimerobotId.get(urId) ?? String(urId);
      out.push({
        contact_id,
        threshold: Number(row.threshold ?? 0) || 0,
        recurrence: Number(row.recurrence ?? 0) || 0,
      });
    }
    return out.sort((a, b) => a.contact_id.localeCompare(b.contact_id));
  }

  if (typeof raw === "string" && raw.trim()) {
    for (const part of raw.split("-")) {
      const bits = part.split("_");
      const urId = parseUptimerobotId(bits[0]);
      if (urId == null) continue;
      const contact_id = contactIdByUptimerobotId.get(urId) ?? String(urId);
      out.push({
        contact_id,
        threshold: Number(bits[1] ?? 0) || 0,
        recurrence: Number(bits[2] ?? 0) || 0,
      });
    }
    return out.sort((a, b) => a.contact_id.localeCompare(b.contact_id));
  }

  return out;
}

/**
 * @param {ConfigMonitorAlertContact[]} contacts
 * @param {Map<string, number>} contactUptimerobotIdByHdcId
 */
export function formatMonitorAlertContactsForApi(contacts, contactUptimerobotIdByHdcId) {
  if (!contacts.length) return undefined;
  return contacts
    .map((c) => {
      const urId = contactUptimerobotIdByHdcId.get(c.contact_id);
      if (urId == null) return null;
      return `${urId}_${c.threshold ?? 0}_${c.recurrence ?? 0}`;
    })
    .filter(Boolean)
    .join("-");
}

/**
 * @param {unknown} rawMonitors
 * @param {Map<number, string>} monitorIdByUptimerobotId
 * @returns {"all" | string[]}
 */
export function pspMonitorsFromApi(rawMonitors, monitorIdByUptimerobotId) {
  if (rawMonitors === 0 || rawMonitors === "0") return "all";
  const s = String(rawMonitors ?? "").trim();
  if (!s || s === "0") return "all";
  const ids = s
    .split("-")
    .map((part) => parseUptimerobotId(part))
    .filter((id) => id != null)
    .map((id) => monitorIdByUptimerobotId.get(/** @type {number} */ (id)) ?? String(id))
    .sort((a, b) => a.localeCompare(b));
  return ids.length ? ids : "all";
}

/**
 * @param {"all" | string[]} monitors
 * @param {Map<string, number>} monitorUptimerobotIdByHdcId
 */
export function pspMonitorsToApi(monitors, monitorUptimerobotIdByHdcId) {
  if (monitors === "all") return 0;
  if (!Array.isArray(monitors) || monitors.length === 0) return 0;
  return monitors
    .map((id) => monitorUptimerobotIdByHdcId.get(id))
    .filter((n) => n != null)
    .sort((a, b) => a - b)
    .join("-");
}

/**
 * @param {import('./uptimerobot-api.mjs').UptimerobotMonitorRow} row
 * @param {ConfigMonitor | null} [existing]
 * @param {Map<number, string>} contactIdByUptimerobotId
 * @param {Set<string>} usedIds
 */
export function liveMonitorToConfig(row, existing, contactIdByUptimerobotId, usedIds) {
  const uptimerobot_id = parseUptimerobotId(row.id);
  if (uptimerobot_id == null) return null;

  /** @type {Record<string, unknown>} */
  const options = {};
  if (row.sub_type !== "" && row.sub_type != null) {
    const sub = String(row.sub_type);
    options.sub_type = PORT_SUB_TYPE_FROM_API[sub] ?? (sub ? `type_${sub}` : undefined);
  }
  if (row.port !== "" && row.port != null) options.port = Number(row.port) || row.port;
  if (row.keyword_type !== "" && row.keyword_type != null) {
    options.keyword_type = Number(row.keyword_type) === 2 ? "not_exists" : "exists";
  }
  if (row.keyword_case_type !== "" && row.keyword_case_type != null) {
    options.keyword_case_type = Number(row.keyword_case_type) === 1 ? "insensitive" : "sensitive";
  }
  if (typeof row.keyword_value === "string" && row.keyword_value.trim()) {
    options.keyword_value = row.keyword_value.trim();
  }
  if (typeof row.http_username === "string" && row.http_username.trim()) {
    options.http_username = row.http_username.trim();
  }
  if (row.http_auth_type !== "" && row.http_auth_type != null) {
    options.http_auth_type = Number(row.http_auth_type) === 2 ? "digest" : "basic";
  }
  if (row.ignore_ssl_errors != null && String(row.ignore_ssl_errors) !== "") {
    options.ignore_ssl_errors = Number(row.ignore_ssl_errors) === 1;
  }
  if (typeof row.custom_http_statuses === "string" && row.custom_http_statuses.trim()) {
    options.custom_http_statuses = row.custom_http_statuses.trim();
  }
  if (row.http_method != null && String(row.http_method) !== "") {
    options.http_method = Number(row.http_method);
  }

  const friendly_name =
    typeof row.friendly_name === "string" && row.friendly_name.trim()
      ? row.friendly_name.trim()
      : `monitor-${uptimerobot_id}`;

  return {
    id:
      existing?.id ??
      deriveResourceId("monitor", uptimerobot_id, friendly_name, usedIds),
    uptimerobot_id,
    friendly_name,
    type: monitorTypeFromApi(row.type),
    url: typeof row.url === "string" && row.url.trim() ? row.url.trim() : null,
    interval_seconds: Number(row.interval ?? 300) || 300,
    status: monitorStatusFromApi(row.status),
    managed: existing?.managed ?? false,
    notes: existing?.notes ?? null,
    alert_contacts: parseMonitorAlertContacts(row.alert_contacts, contactIdByUptimerobotId),
    options,
  };
}

/**
 * @param {import('./uptimerobot-api.mjs').UptimerobotAlertContactRow} row
 * @param {ConfigAlertContact | null} [existing]
 * @param {Set<string>} usedIds
 */
export function liveAlertContactToConfig(row, existing, usedIds) {
  const uptimerobot_id = parseUptimerobotId(row.id);
  if (uptimerobot_id == null) return null;

  const friendly_name =
    typeof row.friendly_name === "string" && row.friendly_name.trim()
      ? row.friendly_name.trim()
      : `contact-${uptimerobot_id}`;

  return {
    id:
      existing?.id ??
      deriveResourceId("contact", uptimerobot_id, friendly_name, usedIds),
    uptimerobot_id,
    friendly_name,
    type: alertContactTypeFromApi(row.type),
    value: typeof row.value === "string" && row.value.trim() ? row.value.trim() : null,
    status: alertContactStatusFromApi(row.status),
    managed: existing?.managed ?? false,
    notes: existing?.notes ?? null,
  };
}

/**
 * @param {import('./uptimerobot-api.mjs').UptimerobotPspRow} row
 * @param {ConfigStatusPage | null} [existing]
 * @param {Map<number, string>} monitorIdByUptimerobotId
 * @param {Set<string>} usedIds
 */
export function liveStatusPageToConfig(row, existing, monitorIdByUptimerobotId, usedIds) {
  const uptimerobot_id = parseUptimerobotId(row.id);
  if (uptimerobot_id == null) return null;

  const friendly_name =
    typeof row.friendly_name === "string" && row.friendly_name.trim()
      ? row.friendly_name.trim()
      : `status-${uptimerobot_id}`;

  const custom_url =
    typeof row.custom_url === "string" && row.custom_url.trim()
      ? row.custom_url.trim()
      : typeof row.custom_domain === "string" && row.custom_domain.trim()
        ? row.custom_domain.trim()
        : null;

  return {
    id:
      existing?.id ??
      deriveResourceId("status", uptimerobot_id, friendly_name, usedIds),
    uptimerobot_id,
    friendly_name,
    standard_url:
      typeof row.standard_url === "string" && row.standard_url.trim()
        ? row.standard_url.trim()
        : null,
    custom_url,
    monitors: pspMonitorsFromApi(row.monitors, monitorIdByUptimerobotId),
    sort: pspSortFromApi(row.sort),
    status: pspStatusFromApi(row.status),
    managed: existing?.managed ?? false,
    notes: existing?.notes ?? null,
  };
}

/**
 * @param {import('./uptimerobot-api.mjs').UptimerobotAccount} account
 */
export function liveAccountToConfig(account) {
  return {
    email: typeof account.email === "string" ? account.email : null,
    monitor_limit:
      typeof account.monitor_limit === "number" ? account.monitor_limit : null,
    monitor_interval:
      typeof account.monitor_interval === "number" ? account.monitor_interval : null,
    up_monitors: typeof account.up_monitors === "number" ? account.up_monitors : null,
    down_monitors: typeof account.down_monitors === "number" ? account.down_monitors : null,
    pause_monitors:
      typeof account.pause_monitors === "number" ? account.pause_monitors : null,
  };
}

/**
 * @param {ConfigMonitor} cfg
 * @param {ConfigMonitor} live
 */
export function monitorHasDrift(cfg, live) {
  if (cfg.uptimerobot_id !== live.uptimerobot_id) return true;
  if (cfg.friendly_name !== live.friendly_name) return true;
  if (cfg.type !== live.type) return true;
  if ((cfg.url ?? null) !== (live.url ?? null)) return true;
  if (cfg.interval_seconds !== live.interval_seconds) return true;
  if (cfg.status !== live.status) return true;
  if (JSON.stringify(cfg.alert_contacts) !== JSON.stringify(live.alert_contacts)) return true;
  if (JSON.stringify(cfg.options ?? {}) !== JSON.stringify(live.options ?? {})) return true;
  return false;
}

/**
 * @param {ConfigAlertContact} cfg
 * @param {ConfigAlertContact} live
 */
export function alertContactHasDrift(cfg, live) {
  if (cfg.uptimerobot_id !== live.uptimerobot_id) return true;
  if (cfg.friendly_name !== live.friendly_name) return true;
  if (cfg.type !== live.type) return true;
  if (cfg.status !== live.status) return true;
  if ((cfg.value ?? "") !== (live.value ?? "")) return true;
  return false;
}

/**
 * @param {ConfigStatusPage} cfg
 * @param {ConfigStatusPage} live
 */
export function statusPageHasDrift(cfg, live) {
  if (cfg.uptimerobot_id !== live.uptimerobot_id) return true;
  if (cfg.friendly_name !== live.friendly_name) return true;
  if ((cfg.standard_url ?? null) !== (live.standard_url ?? null)) return true;
  if ((cfg.custom_url ?? null) !== (live.custom_url ?? null)) return true;
  if (cfg.sort !== live.sort) return true;
  if (cfg.status !== live.status) return true;
  const cfgMon = cfg.monitors === "all" ? "all" : [...cfg.monitors].sort().join(",");
  const liveMon = live.monitors === "all" ? "all" : [...live.monitors].sort().join(",");
  if (cfgMon !== liveMon) return true;
  return false;
}

/**
 * @param {unknown} raw
 */
export function normalizeUptimerobotConfig(raw) {
  const ur =
    raw && typeof raw === "object" && raw.uptimerobot && typeof raw.uptimerobot === "object"
      ? raw.uptimerobot
      : {};
  const auth = isObject(ur.auth) ? ur.auth : {};

  /** @type {ConfigMonitor[]} */
  const monitors = Array.isArray(raw.monitors)
    ? raw.monitors
        .filter((m) => isObject(m) && typeof m.id === "string")
        .map((m) => ({
          id: String(m.id),
          uptimerobot_id: Number(m.uptimerobot_id),
          friendly_name: String(m.friendly_name ?? m.id),
          type: String(m.type ?? "http"),
          url: typeof m.url === "string" ? m.url : null,
          interval_seconds: Number(m.interval_seconds ?? 300) || 300,
          status: String(m.status ?? "not_checked"),
          managed: m.managed === true,
          notes: typeof m.notes === "string" ? m.notes : null,
          alert_contacts: Array.isArray(m.alert_contacts)
            ? m.alert_contacts
                .filter((c) => isObject(c) && typeof c.contact_id === "string")
                .map((c) => ({
                  contact_id: String(c.contact_id),
                  threshold: Number(c.threshold ?? 0) || 0,
                  recurrence: Number(c.recurrence ?? 0) || 0,
                }))
            : [],
          options: isObject(m.options) ? { ...m.options } : {},
        }))
    : [];

  /** @type {ConfigAlertContact[]} */
  const alert_contacts = Array.isArray(raw.alert_contacts)
    ? raw.alert_contacts
        .filter((c) => isObject(c) && typeof c.id === "string")
        .map((c) => ({
          id: String(c.id),
          uptimerobot_id: Number(c.uptimerobot_id),
          friendly_name: String(c.friendly_name ?? c.id),
          type: String(c.type ?? "email"),
          value: typeof c.value === "string" ? c.value : null,
          status: String(c.status ?? "not_activated"),
          managed: c.managed === true,
          notes: typeof c.notes === "string" ? c.notes : null,
        }))
    : [];

  /** @type {ConfigStatusPage[]} */
  const status_pages = Array.isArray(raw.status_pages)
    ? raw.status_pages
        .filter((p) => isObject(p) && typeof p.id === "string")
        .map((p) => ({
          id: String(p.id),
          uptimerobot_id: Number(p.uptimerobot_id),
          friendly_name: String(p.friendly_name ?? p.id),
          standard_url: typeof p.standard_url === "string" ? p.standard_url : null,
          custom_url: typeof p.custom_url === "string" ? p.custom_url : null,
          monitors:
            p.monitors === "all"
              ? "all"
              : Array.isArray(p.monitors)
                ? p.monitors.filter((m) => typeof m === "string").map(String)
                : "all",
          sort: String(p.sort ?? "name_asc"),
          status: String(p.status ?? "active"),
          managed: p.managed === true,
          notes: typeof p.notes === "string" ? p.notes : null,
        }))
    : [];

  const accountRaw = isObject(ur.account) ? ur.account : {};

  return {
    apiBase:
      typeof ur.api_base_url === "string" && ur.api_base_url.trim()
        ? ur.api_base_url.trim().replace(/\/$/, "")
        : "https://api.uptimerobot.com/v2",
    apiKeyVaultKey:
      typeof auth.api_key_vault_key === "string" && auth.api_key_vault_key.trim()
        ? auth.api_key_vault_key.trim()
        : UPTIMEROBOT_API_KEY_VAULT_KEY,
    primaryStatusPageUrl:
      typeof ur.primary_status_page_url === "string" && ur.primary_status_page_url.trim()
        ? ur.primary_status_page_url.trim()
        : null,
    account: {
      email: typeof accountRaw.email === "string" ? accountRaw.email : null,
      monitor_limit:
        typeof accountRaw.monitor_limit === "number" ? accountRaw.monitor_limit : null,
      monitor_interval:
        typeof accountRaw.monitor_interval === "number" ? accountRaw.monitor_interval : null,
      up_monitors: typeof accountRaw.up_monitors === "number" ? accountRaw.up_monitors : null,
      down_monitors:
        typeof accountRaw.down_monitors === "number" ? accountRaw.down_monitors : null,
      pause_monitors:
        typeof accountRaw.pause_monitors === "number" ? accountRaw.pause_monitors : null,
    },
    monitors,
    status_pages,
    alert_contacts,
    monitorsById: new Map(monitors.map((m) => [m.id, m])),
    monitorsByUptimerobotId: new Map(monitors.map((m) => [m.uptimerobot_id, m])),
    alertContactsById: new Map(alert_contacts.map((c) => [c.id, c])),
    alertContactsByUptimerobotId: new Map(alert_contacts.map((c) => [c.uptimerobot_id, c])),
    statusPagesById: new Map(status_pages.map((p) => [p.id, p])),
    statusPagesByUptimerobotId: new Map(status_pages.map((p) => [p.uptimerobot_id, p])),
  };
}

/**
 * Build API fields for newMonitor/editMonitor from config entry.
 * @param {ConfigMonitor} entry
 * @param {Map<string, number>} contactUptimerobotIdByHdcId
 * @param {boolean} [forEdit]
 */
export function monitorToApiFields(entry, contactUptimerobotIdByHdcId, forEdit = false) {
  /** @type {Record<string, string | number>} */
  const fields = {};
  if (forEdit) fields.id = entry.uptimerobot_id;
  fields.friendly_name = entry.friendly_name;
  if (entry.url) fields.url = entry.url;
  if (!forEdit) fields.type = monitorTypeToApi(entry.type);
  fields.interval = entry.interval_seconds;

  const opts = entry.options ?? {};
  if (opts.sub_type != null) {
    const sub = String(opts.sub_type);
    fields.sub_type =
      PORT_SUB_TYPE_TO_API[/** @type {keyof typeof PORT_SUB_TYPE_TO_API} */ (sub)] ??
      Number(/^type_(\d+)$/.exec(sub)?.[1] ?? sub);
  }
  if (opts.port != null) fields.port = Number(opts.port);
  if (opts.keyword_type === "not_exists") fields.keyword_type = 2;
  else if (opts.keyword_type === "exists") fields.keyword_type = 1;
  if (opts.keyword_case_type === "insensitive") fields.keyword_case_type = 1;
  else if (opts.keyword_case_type === "sensitive") fields.keyword_case_type = 0;
  if (typeof opts.keyword_value === "string") fields.keyword_value = opts.keyword_value;
  if (typeof opts.http_username === "string") fields.http_username = opts.http_username;
  if (opts.http_auth_type === "digest") fields.http_auth_type = 2;
  else if (opts.http_auth_type === "basic") fields.http_auth_type = 1;
  if (opts.ignore_ssl_errors === true) fields.ignore_ssl_errors = 1;
  if (typeof opts.custom_http_statuses === "string") {
    fields.custom_http_statuses = opts.custom_http_statuses;
  }
  if (opts.http_method != null) fields.http_method = Number(opts.http_method);

  const alertContacts = formatMonitorAlertContactsForApi(
    entry.alert_contacts,
    contactUptimerobotIdByHdcId
  );
  if (alertContacts) fields.alert_contacts = alertContacts;

  if (forEdit) {
    if (entry.status === "paused") fields.status = 0;
    else fields.status = 1;
  }

  return fields;
}

/**
 * @param {ConfigStatusPage} entry
 * @param {Map<string, number>} monitorUptimerobotIdByHdcId
 * @param {boolean} [forEdit]
 */
export function statusPageToApiFields(entry, monitorUptimerobotIdByHdcId, forEdit = false) {
  /** @type {Record<string, string | number>} */
  const fields = {};
  if (forEdit) fields.id = entry.uptimerobot_id;
  if (!forEdit) fields.type = 1;
  fields.friendly_name = entry.friendly_name;
  fields.monitors = pspMonitorsToApi(entry.monitors, monitorUptimerobotIdByHdcId);
  fields.sort = pspSortToApi(entry.sort);
  fields.status = pspStatusToApi(entry.status);
  if (entry.custom_url) fields.custom_domain = entry.custom_url.replace(/^https?:\/\//, "");
  return fields;
}

/**
 * @param {ConfigAlertContact} entry
 * @param {boolean} [forEdit]
 */
export function alertContactToApiFields(entry, forEdit = false) {
  /** @type {Record<string, string | number>} */
  const fields = {};
  if (forEdit) fields.id = entry.uptimerobot_id;
  fields.friendly_name = entry.friendly_name;
  fields.type = alertContactTypeToApi(entry.type);
  if (entry.value) fields.value = entry.value;
  if (forEdit) fields.status = alertContactStatusToApi(entry.status);
  return fields;
}

export {
  MONITOR_TYPE_TO_API,
  MONITOR_TYPE_FROM_API,
  MONITOR_STATUS_TO_API,
  MONITOR_STATUS_FROM_API,
  PSP_SORT_TO_API,
  PSP_SORT_FROM_API,
  ALERT_CONTACT_TYPE_TO_API,
  ALERT_CONTACT_TYPE_FROM_API,
  PORT_SUB_TYPE_TO_API,
  PORT_SUB_TYPE_FROM_API,
};
