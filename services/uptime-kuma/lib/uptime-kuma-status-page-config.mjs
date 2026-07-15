import { findLiveMonitor, parseUptimeKumaId } from "./uptime-kuma-config.mjs";

/** @typedef {{
 *   id: string;
 *   send_url?: boolean;
 *   url?: string | null;
 * }} ConfigStatusPageMonitor */

/** @typedef {{
 *   name: string;
 *   weight?: number;
 *   monitors: ConfigStatusPageMonitor[];
 * }} ConfigStatusPageGroup */

/** @typedef {{
 *   id: string;
 *   slug: string;
 *   title: string;
 *   description: string | null;
 *   theme: string;
 *   published: boolean;
 *   show_tags: boolean;
 *   show_powered_by: boolean;
 *   show_certificate_expiry: boolean;
 *   show_only_last_heartbeat: boolean;
 *   auto_refresh_interval: number;
 *   custom_css: string;
 *   footer_text: string | null;
 *   rss_title: string | null;
 *   domain_names: string[];
 *   icon: string;
 *   analytics_id: string | null;
 *   analytics_script_url: string | null;
 *   analytics_type: string | null;
 *   groups: ConfigStatusPageGroup[];
 *   managed: boolean;
 * }} ConfigStatusPage */

/** @typedef {ConfigStatusPage & { uptime_kuma_id?: number | null }} LiveStatusPage */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} slug
 */
export function statusPageIdFromSlug(slug) {
  return String(slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * @param {import('./uptime-kuma-config.mjs').LiveMonitor[]} liveMonitors
 */
export function buildMonitorHdcIdByUptimeKumaIdFromLive(liveMonitors) {
  /** @type {Map<number, string>} */
  const map = new Map();
  for (const m of liveMonitors) {
    if (m.uptime_kuma_id != null) {
      map.set(m.uptime_kuma_id, m.id);
    }
  }
  return map;
}

/** @deprecated use buildMonitorHdcIdByUptimeKumaIdFromLive */
export function buildMonitorHdcIdByUptimeKumaId(liveMonitors) {
  return buildMonitorHdcIdByUptimeKumaIdFromLive(liveMonitors);
}

/**
 * @param {unknown} raw
 */
export function normalizeUptimeKumaStatusPageConfig(raw) {
  /** @type {ConfigStatusPage[]} */
  const status_pages = Array.isArray(raw?.status_pages)
    ? raw.status_pages
        .filter((p) => isObject(p) && typeof p.slug === "string" && p.slug.trim())
        .map((p) => normalizeStatusPageEntry(p))
    : [];

  return {
    status_pages,
    statusPagesById: new Map(status_pages.map((p) => [p.id, p])),
    statusPagesBySlug: new Map(status_pages.map((p) => [p.slug.toLowerCase(), p])),
  };
}

/**
 * @param {Record<string, unknown>} p
 */
function normalizeStatusPageEntry(p) {
  const slug = String(p.slug).trim().toLowerCase();
  return {
    id: typeof p.id === "string" && p.id.trim() ? String(p.id).trim() : statusPageIdFromSlug(slug),
    slug,
    title: typeof p.title === "string" && p.title.trim() ? p.title.trim() : slug,
    description: typeof p.description === "string" ? p.description : null,
    theme: typeof p.theme === "string" && p.theme.trim() ? p.theme.trim() : "auto",
    published: p.published !== false,
    show_tags: p.show_tags === true,
    show_powered_by: p.show_powered_by !== false,
    show_certificate_expiry: p.show_certificate_expiry === true,
    show_only_last_heartbeat: p.show_only_last_heartbeat === true,
    auto_refresh_interval: Number(p.auto_refresh_interval ?? 300) || 300,
    custom_css: typeof p.custom_css === "string" ? p.custom_css : "",
    footer_text: typeof p.footer_text === "string" ? p.footer_text : null,
    rss_title: typeof p.rss_title === "string" ? p.rss_title : null,
    domain_names: Array.isArray(p.domain_names)
      ? p.domain_names.filter((d) => typeof d === "string" && d.trim()).map((d) => String(d).trim())
      : [],
    icon: typeof p.icon === "string" ? p.icon : "/icon.svg",
    analytics_id: typeof p.analytics_id === "string" ? p.analytics_id : null,
    analytics_script_url: typeof p.analytics_script_url === "string" ? p.analytics_script_url : null,
    analytics_type: typeof p.analytics_type === "string" ? p.analytics_type : null,
    groups: normalizeStatusPageGroups(p.groups),
    managed: p.managed === true,
  };
}

/**
 * @param {unknown} groups
 */
function normalizeStatusPageGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((g) => isObject(g) && typeof g.name === "string" && g.name.trim())
    .map((g, idx) => ({
      name: String(g.name).trim(),
      weight: Number(g.weight ?? idx + 1) || idx + 1,
      monitors: normalizeStatusPageGroupMonitors(g.monitors),
    }));
}

/**
 * @param {unknown} monitors
 */
function normalizeStatusPageGroupMonitors(monitors) {
  if (!Array.isArray(monitors)) return [];
  return monitors
    .filter((m) => isObject(m) && typeof m.id === "string" && m.id.trim())
    .map((m) => ({
      id: String(m.id).trim(),
      send_url: m.send_url === true,
      url: typeof m.url === "string" ? m.url : null,
    }));
}

/**
 * @param {Record<string, unknown>[]} publicGroupList
 * @param {Map<number, string>} monitorHdcIdByUkId
 * @param {(line: string) => void} log
 */
export function groupsFromPublicGroupList(publicGroupList, monitorHdcIdByUkId, log = () => {}) {
  if (!Array.isArray(publicGroupList)) return [];
  /** @type {ConfigStatusPageGroup[]} */
  const groups = [];
  let weight = 1;
  for (const group of publicGroupList) {
    if (!isObject(group)) continue;
    const monitorList = Array.isArray(group.monitorList) ? group.monitorList : [];
    /** @type {ConfigStatusPageMonitor[]} */
    const monitors = [];
    for (const monitor of monitorList) {
      if (!isObject(monitor)) continue;
      const ukId = parseUptimeKumaId(monitor.id);
      if (ukId == null) continue;
      const hdcId = monitorHdcIdByUkId.get(ukId);
      if (!hdcId) {
        log(`skip status page monitor uk id=${ukId}: no hdc monitor id mapping`);
        continue;
      }
      monitors.push({
        id: hdcId,
        send_url: monitor.sendUrl === true || monitor.send_url === true,
        url: typeof monitor.url === "string" ? monitor.url : null,
      });
    }
    groups.push({
      name: String(group.name ?? "Group").trim(),
      weight: Number(group.weight ?? weight) || weight,
      monitors,
    });
    weight += 1;
  }
  return groups;
}

/**
 * @param {Record<string, unknown>} listRow
 * @param {Record<string, unknown>} [socketConfig]
 * @param {Record<string, unknown>} [publicData]
 * @param {Map<number, string>} monitorHdcIdByUkId
 * @param {ConfigStatusPage | null} [existing]
 * @param {{ log?: (line: string) => void; importManagedDefault?: boolean }} [opts]
 */
export function liveStatusPageToConfig(
  listRow,
  socketConfig = {},
  publicData = {},
  monitorHdcIdByUkId = new Map(),
  existing = null,
  opts = {},
) {
  const log = opts.log ?? (() => {});
  const importManagedDefault = opts.importManagedDefault !== false;
  const slug = String(listRow.slug ?? socketConfig.slug ?? "").trim().toLowerCase();
  if (!slug) return null;

  const merged = { ...listRow, ...socketConfig };
  const publicGroupList = Array.isArray(publicData.publicGroupList) ? publicData.publicGroupList : [];

  return {
    id: existing?.id ?? statusPageIdFromSlug(slug),
    slug,
    title: existing?.title ?? String(merged.title ?? slug).trim(),
    description:
      existing?.description ??
      (typeof merged.description === "string" ? merged.description : null),
    theme: existing?.theme ?? (typeof merged.theme === "string" ? merged.theme : "auto"),
    published: existing?.published ?? merged.published !== false,
    show_tags:
      existing?.show_tags ??
      (merged.showTags === true || merged.show_tags === true),
    show_powered_by:
      existing?.show_powered_by ??
      (merged.showPoweredBy !== false && merged.show_powered_by !== false),
    show_certificate_expiry:
      existing?.show_certificate_expiry ??
      (merged.showCertificateExpiry === true || merged.show_certificate_expiry === true),
    show_only_last_heartbeat:
      existing?.show_only_last_heartbeat ??
      (merged.showOnlyLastHeartbeat === true || merged.show_only_last_heartbeat === true),
    auto_refresh_interval:
      existing?.auto_refresh_interval ??
      (Number(merged.autoRefreshInterval ?? merged.auto_refresh_interval ?? 300) || 300),
    custom_css:
      existing?.custom_css ??
      (typeof merged.customCSS === "string"
        ? merged.customCSS
        : typeof merged.custom_css === "string"
          ? merged.custom_css
          : ""),
    footer_text:
      existing?.footer_text ??
      (typeof merged.footerText === "string"
        ? merged.footerText
        : typeof merged.footer_text === "string"
          ? merged.footer_text
          : null),
    rss_title:
      existing?.rss_title ??
      (typeof merged.rssTitle === "string"
        ? merged.rssTitle
        : typeof merged.rss_title === "string"
          ? merged.rss_title
          : null),
    domain_names:
      existing?.domain_names ??
      (Array.isArray(merged.domainNameList)
        ? merged.domainNameList.filter((d) => typeof d === "string").map(String)
        : Array.isArray(merged.domain_names)
          ? merged.domain_names.filter((d) => typeof d === "string").map(String)
          : []),
    icon:
      existing?.icon ??
      (typeof merged.icon === "string" && merged.icon.trim() ? merged.icon : "/icon.svg"),
    analytics_id:
      existing?.analytics_id ??
      (typeof merged.analyticsId === "string"
        ? merged.analyticsId
        : typeof merged.analytics_id === "string"
          ? merged.analytics_id
          : null),
    analytics_script_url:
      existing?.analytics_script_url ??
      (typeof merged.analyticsScriptUrl === "string"
        ? merged.analyticsScriptUrl
        : typeof merged.analytics_script_url === "string"
          ? merged.analytics_script_url
          : null),
    analytics_type:
      existing?.analytics_type ??
      (typeof merged.analyticsType === "string"
        ? merged.analyticsType
        : typeof merged.analytics_type === "string"
          ? merged.analytics_type
          : null),
    groups:
      existing?.groups?.length
        ? existing.groups
        : groupsFromPublicGroupList(publicGroupList, monitorHdcIdByUkId, log),
    managed: existing?.managed ?? (importManagedDefault ? true : false),
  };
}

/**
 * @param {ConfigStatusPageGroup[]} groups
 */
export function normalizedGroupSignature(groups) {
  return groups.map((g) => ({
    name: g.name,
    weight: g.weight ?? 0,
    monitors: g.monitors.map((m) => ({
      id: m.id,
      send_url: m.send_url === true,
      url: m.url ?? null,
    })),
  }));
}

/**
 * @param {ConfigStatusPage} cfg
 * @param {LiveStatusPage} live
 */
export function statusPageHasDrift(cfg, live) {
  if (cfg.slug !== live.slug) return true;
  if (cfg.title !== live.title) return true;
  if ((cfg.description ?? "") !== (live.description ?? "")) return true;
  if (cfg.theme !== live.theme) return true;
  if (cfg.show_tags !== live.show_tags) return true;
  if (cfg.show_powered_by !== live.show_powered_by) return true;
  if (cfg.show_certificate_expiry !== live.show_certificate_expiry) return true;
  if (cfg.show_only_last_heartbeat !== live.show_only_last_heartbeat) return true;
  if (cfg.auto_refresh_interval !== live.auto_refresh_interval) return true;
  if ((cfg.custom_css ?? "") !== (live.custom_css ?? "")) return true;
  if ((cfg.footer_text ?? "") !== (live.footer_text ?? "")) return true;
  if ((cfg.rss_title ?? "") !== (live.rss_title ?? "")) return true;
  if ((cfg.icon ?? "") !== (live.icon ?? "")) return true;
  const cfgDomains = [...(cfg.domain_names ?? [])].sort().join(",");
  const liveDomains = [...(live.domain_names ?? [])].sort().join(",");
  if (cfgDomains !== liveDomains) return true;
  if (
    JSON.stringify(normalizedGroupSignature(cfg.groups)) !==
    JSON.stringify(normalizedGroupSignature(live.groups))
  ) {
    return true;
  }
  return false;
}

/**
 * @param {ConfigStatusPage} entry
 */
export function statusPageToSaveConfig(entry) {
  return {
    slug: entry.slug,
    title: entry.title,
    description: entry.description ?? "",
    theme: entry.theme ?? "auto",
    showTags: entry.show_tags === true,
    footerText: entry.footer_text ?? null,
    customCSS: entry.custom_css ?? "",
    showPoweredBy: entry.show_powered_by !== false,
    rssTitle: entry.rss_title ?? null,
    showOnlyLastHeartbeat: entry.show_only_last_heartbeat === true,
    showCertificateExpiry: entry.show_certificate_expiry === true,
    analyticsId: entry.analytics_id ?? null,
    analyticsScriptUrl: entry.analytics_script_url ?? null,
    analyticsType: entry.analytics_type ?? null,
    domainNameList: entry.domain_names ?? [],
    autoRefreshInterval: entry.auto_refresh_interval ?? 300,
  };
}

/**
 * @param {ConfigStatusPage} entry
 * @param {import('./uptime-kuma-config.mjs').ConfigMonitor[]} configMonitors
 * @param {import('./uptime-kuma-config.mjs').LiveMonitor[]} liveMonitors
 */
export function buildPublicGroupListForSave(entry, configMonitors, liveMonitors) {
  const byHdcId = new Map(configMonitors.map((m) => [m.id, m]));
  return entry.groups.map((group, idx) => ({
    name: group.name,
    weight: group.weight ?? idx + 1,
    monitorList: group.monitors
      .map((m) => {
        const configMonitor = byHdcId.get(m.id);
        if (!configMonitor) return null;
        const liveMonitor = findLiveMonitor(configMonitor, liveMonitors);
        if (!liveMonitor?.uptime_kuma_id) return null;
        /** @type {Record<string, unknown>} */
        const row = { id: liveMonitor.uptime_kuma_id };
        if (m.send_url === true) row.sendUrl = true;
        if (m.url) row.url = m.url;
        return row;
      })
      .filter(Boolean),
  }));
}
