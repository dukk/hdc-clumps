import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { writeUptimeKumaConfig } from "./uptime-kuma-config-write.mjs";
import {
  importMonitorsFromHomepage,
  mergeHomepageMonitorsIntoConfig,
} from "./uptime-kuma-homepage-import.mjs";
import {
  buildMonitorByIdMap,
  collectTagsCatalogFromRows,
  liveMonitorRowToConfig,
  resolveUptimeKumaApiUrl,
  slugifyMonitorId,
} from "./uptime-kuma-config.mjs";
import {
  statusPageIdFromSlug,
} from "./uptime-kuma-status-page-config.mjs";
import { normalizeUptimeKumaConfig } from "./deployments.mjs";

export const UPTIME_KUMA_COMPACT_ARRAY_KEYS = ["monitors", "status_pages"];

const CLUMP_CONFIG_EXAMPLE = "clumps/services/uptime-kuma/config.example.json";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} page
 */
function stripStatusPageRuntimeFields(page) {
  const { uptime_kuma_id: _removed, ...config } = page;
  return config;
}

/**
 * @param {Awaited<ReturnType<import('./uptime-kuma-collect.mjs').fetchLiveUptimeKumaMonitors>>} live
 * @param {unknown[]} existingMonitors
 * @param {(line: string) => void} [log]
 */
export function liveMonitorsToConfigEntries(live, existingMonitors, log = () => {}) {
  const existingById = new Map(
    (Array.isArray(existingMonitors) ? existingMonitors : [])
      .filter((m) => isObject(m) && typeof m.id === "string")
      .map((m) => [String(m.id), m]),
  );
  const existingByName = new Map(
    (Array.isArray(existingMonitors) ? existingMonitors : [])
      .filter((m) => isObject(m) && typeof m.name === "string" && m.name.trim())
      .map((m) => [String(m.name).trim().toLowerCase(), m]),
  );

  const monitorById = buildMonitorByIdMap(live.raw.monitorRows);

  return live.raw.monitorRows
    .map((raw) => {
      const slugFromName =
        typeof raw.name === "string" ? slugifyMonitorId(raw.name) : "";
      const existing =
        (slugFromName ? existingById.get(slugFromName) ?? null : null) ??
        (typeof raw.name === "string"
          ? existingByName.get(String(raw.name).trim().toLowerCase()) ?? null
          : null);

      const existingCfg =
        existing && isObject(existing)
          ? /** @type {import('./uptime-kuma-config.mjs').ConfigMonitor} */ ({
              id: String(existing.id),
              name: typeof existing.name === "string" ? existing.name : String(raw.name ?? ""),
              type: typeof existing.type === "string" ? existing.type : String(raw.type ?? "http"),
              url: typeof existing.url === "string" ? existing.url : null,
              hostname: typeof existing.hostname === "string" ? existing.hostname : null,
              group: typeof existing.group === "string" ? existing.group : null,
              tags: Array.isArray(existing.tags)
                ? existing.tags.filter((t) => typeof t === "string")
                : [],
              interval: Number(existing.interval ?? raw.interval) || 60,
              ignore_tls: existing.ignore_tls === true,
              managed: existing.managed === true,
              notes: typeof existing.notes === "string" ? existing.notes : null,
            })
          : null;

      return liveMonitorRowToConfig(raw, existingCfg, monitorById, { log, importManagedDefault: true });
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {Awaited<ReturnType<import('./uptime-kuma-status-page-collect.mjs').fetchLiveUptimeKumaStatusPages>>} liveStatusPages
 * @param {unknown[]} existingStatusPages
 * @param {import('./uptime-kuma-config.mjs').ConfigMonitor[]} monitors
 * @param {(line: string) => void} [log]
 */
export function liveStatusPagesToConfigEntries(liveStatusPages, existingStatusPages, _monitors, _log = () => {}) {
  const existingBySlug = new Map(
    (Array.isArray(existingStatusPages) ? existingStatusPages : [])
      .filter((p) => isObject(p) && typeof p.slug === "string")
      .map((p) => [String(p.slug).toLowerCase(), p]),
  );
  const existingById = new Map(
    (Array.isArray(existingStatusPages) ? existingStatusPages : [])
      .filter((p) => isObject(p) && typeof p.id === "string")
      .map((p) => [String(p.id), p]),
  );

  return liveStatusPages.statusPages
    .map((livePage) => {
      const existing =
        existingBySlug.get(livePage.slug.toLowerCase()) ??
        existingById.get(livePage.id) ??
        existingById.get(statusPageIdFromSlug(livePage.slug)) ??
        null;
      if (existing && isObject(existing)) {
        return stripStatusPageRuntimeFields({
          ...livePage,
          id: String(existing.id),
          managed: existing.managed === true ? true : livePage.managed,
        });
      }
      return stripStatusPageRuntimeFields(livePage);
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {Awaited<ReturnType<import('./uptime-kuma-collect.mjs').fetchLiveUptimeKumaMonitors>>} opts.live
 * @param {Awaited<ReturnType<import('./uptime-kuma-status-page-collect.mjs').fetchLiveUptimeKumaStatusPages>>} [opts.liveStatusPages]
 * @param {(line: string) => void} [opts.log]
 */
export function importUptimeKumaMonitorsToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });

  const existingMonitors = Array.isArray(cfgRaw.monitors) ? cfgRaw.monitors : [];
  const existingTags = Array.isArray(cfgRaw.tags) ? cfgRaw.tags : [];
  const existingStatusPages = Array.isArray(cfgRaw.status_pages) ? cfgRaw.status_pages : [];
  const monitors = liveMonitorsToConfigEntries(opts.live, existingMonitors, log);
  const tags = collectTagsCatalogFromRows(opts.live.raw.monitorRows, existingTags);
  const status_pages = opts.liveStatusPages
    ? liveStatusPagesToConfigEntries(opts.liveStatusPages, existingStatusPages, monitors, log)
    : existingStatusPages;

  const groupsInferred = new Set(monitors.map((m) => m.group).filter(Boolean)).size;
  const statusPageGroups = status_pages.reduce((sum, p) => sum + (p.groups?.length ?? 0), 0);
  const statusPageMonitorLinks = status_pages.reduce(
    (sum, p) => sum + (p.groups ?? []).reduce((gSum, g) => gSum + (g.monitors?.length ?? 0), 0),
    0,
  );

  const next = {
    ...cfgRaw,
    schema_version: Math.max(Number(cfgRaw.schema_version) || 2, 4),
    monitors,
    tags,
    status_pages,
  };

  const { layout } = writeUptimeKumaConfig(resolved, next, {
    compactArrayKeys: UPTIME_KUMA_COMPACT_ARRAY_KEYS,
  });
  log(
    `Wrote ${monitors.length} monitor(s), ${groupsInferred} group(s), ${tags.length} tag(s), ${status_pages.length} status page(s) (${statusPageGroups} page group(s), ${statusPageMonitorLinks} link(s)) to ${layout} config (${source}: ${resolved.rel}).`,
  );

  return {
    monitor_count: monitors.length,
    group_count: groupsInferred,
    tag_count: tags.length,
    status_page_count: status_pages.length,
    status_page_group_count: statusPageGroups,
    status_page_monitor_link_count: statusPageMonitorLinks,
    configPath: resolved.path,
    configRel: resolved.rel,
    source,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string} [opts.repoRoot]
 * @param {(line: string) => void} [opts.log]
 */
export function importHomepageMonitorsToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });

  const { imported } = importMonitorsFromHomepage(opts.repoRoot);
  const existingMonitors = Array.isArray(cfgRaw.monitors) ? cfgRaw.monitors : [];
  const monitors = mergeHomepageMonitorsIntoConfig(imported, existingMonitors);

  const authRaw = isObject(cfgRaw.uptime_kuma_auth) ? cfgRaw.uptime_kuma_auth : {};
  const { defaults, deployments } = normalizeUptimeKumaConfig(cfgRaw);
  const derivedUrl = resolveUptimeKumaApiUrl(cfgRaw, defaults, deployments[0] ?? {});

  const next = {
    ...cfgRaw,
    schema_version: Math.max(Number(cfgRaw.schema_version) || 2, 4),
    uptime_kuma_auth: {
      ...(isObject(authRaw) ? authRaw : {}),
      ...(typeof authRaw.api_url === "string" && authRaw.api_url.trim()
        ? {}
        : derivedUrl
          ? { api_url: derivedUrl }
          : {}),
      username_env:
        typeof authRaw.username_env === "string" && authRaw.username_env.trim()
          ? authRaw.username_env
          : "HDC_UPTIME_KUMA_USERNAME",
      password_vault_key:
        typeof authRaw.password_vault_key === "string" && authRaw.password_vault_key.trim()
          ? authRaw.password_vault_key
          : "HDC_UPTIME_KUMA_PASSWORD",
    },
    monitors,
  };

  const { layout } = writeUptimeKumaConfig(resolved, next, {
    compactArrayKeys: UPTIME_KUMA_COMPACT_ARRAY_KEYS,
  });
  log(`Wrote ${monitors.length} monitor(s) from homepage to ${layout} config (${source}: ${resolved.rel}).`);

  return {
    monitor_count: monitors.length,
    configPath: resolved.path,
    configRel: resolved.rel,
    source,
  };
}
