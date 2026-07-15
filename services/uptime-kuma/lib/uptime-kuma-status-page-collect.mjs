import { fetchStatusPagePublicData } from "./uptime-kuma-api.mjs";
import {
  buildMonitorHdcIdByUptimeKumaIdFromLive,
  liveStatusPageToConfig,
  statusPageHasDrift,
} from "./uptime-kuma-status-page-config.mjs";

/**
 * @typedef {import('./uptime-kuma-status-page-config.mjs').ConfigStatusPage} ConfigStatusPage
 * @typedef {import('./uptime-kuma-status-page-config.mjs').LiveStatusPage} LiveStatusPage
 * @typedef {import('./uptime-kuma-config.mjs').LiveMonitor} LiveMonitor
 */

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {string} baseUrl
 * @param {LiveMonitor[]} liveMonitors
 * @param {(line: string) => void} [log]
 * @param {{ skipLogin?: boolean }} [opts]
 */
export async function fetchLiveUptimeKumaStatusPages(client, baseUrl, liveMonitors, log = () => {}, opts = {}) {
  if (!opts.skipLogin) {
    await client.login();
  }
  const monitorHdcIdByUkId = buildMonitorHdcIdByUptimeKumaIdFromLive(liveMonitors);
  const rows = await client.getStatusPageList();
  log(`live status pages: ${rows.length}`);

  /** @type {LiveStatusPage[]} */
  const statusPages = [];
  for (const row of rows) {
    const slug = typeof row.slug === "string" ? row.slug : null;
    if (!slug) continue;
    try {
      const socketResp = await client.getStatusPage(slug);
      const publicData = await fetchStatusPagePublicData(baseUrl, slug);
      const mapped = liveStatusPageToConfig(
        row,
        socketResp.config && typeof socketResp.config === "object" ? socketResp.config : {},
        publicData,
        monitorHdcIdByUkId,
        null,
        { log },
      );
      if (mapped) {
        statusPages.push({
          ...mapped,
          uptime_kuma_id: Number(row.id) > 0 ? Number(row.id) : null,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`skip status page ${slug}: ${msg}`);
    }
  }

  statusPages.sort((a, b) => a.title.localeCompare(b.title));

  return {
    statusPages,
    raw: { statusPageRows: rows },
  };
}

/**
 * @param {ReturnType<import('./uptime-kuma-status-page-config.mjs').normalizeUptimeKumaStatusPageConfig>} config
 * @param {Awaited<ReturnType<typeof fetchLiveUptimeKumaStatusPages>>} live
 */
export function collectUptimeKumaStatusPageState(config, live) {
  const liveBySlug = new Map(live.statusPages.map((p) => [p.slug.toLowerCase(), p]));

  /** @type {Record<string, unknown>[]} */
  const perPage = [];
  let hasDrift = false;

  for (const entry of config.status_pages) {
    const liveRow = liveBySlug.get(entry.slug.toLowerCase()) ?? null;
    const drift = liveRow ? statusPageHasDrift(entry, liveRow) : entry.managed;
    if (drift) hasDrift = true;
    perPage.push({
      id: entry.id,
      slug: entry.slug,
      uptime_kuma_id: liveRow?.uptime_kuma_id ?? null,
      managed: entry.managed,
      missing_in_live: entry.managed && !liveRow,
      missing_in_config: false,
      drift,
      live: liveRow,
    });
  }

  const configSlugs = new Set(config.status_pages.map((p) => p.slug.toLowerCase()));
  for (const liveRow of live.statusPages) {
    if (!configSlugs.has(liveRow.slug.toLowerCase())) {
      hasDrift = true;
      perPage.push({
        id: liveRow.id,
        slug: liveRow.slug,
        uptime_kuma_id: liveRow.uptime_kuma_id ?? null,
        managed: false,
        missing_in_live: false,
        missing_in_config: true,
        drift: true,
        live: liveRow,
      });
    }
  }

  return {
    status_page_count: config.status_pages.length,
    live_status_page_count: live.statusPages.length,
    has_drift: hasDrift,
    status_pages: perPage,
  };
}
