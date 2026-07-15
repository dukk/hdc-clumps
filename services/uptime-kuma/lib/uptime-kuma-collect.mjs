import {
  buildMonitorByIdMap,
  collectTagsCatalogFromRows,
  findLiveMonitor,
  liveMonitorRowToLive,
  monitorHasDrift,
  parseUptimeKumaId,
} from "./uptime-kuma-config.mjs";

/**
 * @typedef {import('./uptime-kuma-config.mjs').ConfigMonitor} ConfigMonitor
 * @typedef {import('./uptime-kuma-config.mjs').LiveMonitor} LiveMonitor
 */

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {(line: string) => void} [log]
 */
export async function fetchLiveUptimeKumaMonitors(client, log = () => {}, opts = {}) {
  if (!opts.skipLogin) {
    await client.login();
  }
  log("connected to Uptime Kuma API (socket.io)");
  const rows = await client.getMonitorList();
  log(`live monitors: ${rows.length}`);

  const monitorById = buildMonitorByIdMap(rows);

  /** @type {LiveMonitor[]} */
  const monitors = [];
  for (const row of rows) {
    const mapped = liveMonitorRowToLive(row, null, monitorById, { log });
    if (mapped) monitors.push(mapped);
  }

  monitors.sort((a, b) => a.name.localeCompare(b.name));

  const tags = collectTagsCatalogFromRows(rows);

  return {
    monitors,
    tags,
    raw: { monitorRows: rows },
  };
}

/**
 * @param {ReturnType<import('./uptime-kuma-config.mjs').normalizeUptimeKumaMonitorConfig>} config
 * @param {Awaited<ReturnType<typeof fetchLiveUptimeKumaMonitors>>} live
 */
export function collectUptimeKumaMonitorState(config, live) {
  /** @type {Record<string, unknown>[]} */
  const perMonitor = [];
  let hasDrift = false;

  for (const entry of config.monitors) {
    const liveRow = findLiveMonitor(entry, live.monitors);
    const drift = liveRow ? monitorHasDrift(entry, liveRow) : entry.managed;
    if (drift) hasDrift = true;
    perMonitor.push({
      id: entry.id,
      uptime_kuma_id: liveRow?.uptime_kuma_id ?? null,
      managed: entry.managed,
      missing_in_live: entry.managed && !liveRow,
      missing_in_config: false,
      drift,
      live: liveRow,
    });
  }

  for (const liveRow of live.monitors) {
    if (config.monitors.some((entry) => findLiveMonitor(entry, [liveRow]))) continue;
    hasDrift = true;
    perMonitor.push({
      id: liveRow.id,
      uptime_kuma_id: liveRow.uptime_kuma_id,
      managed: false,
      missing_in_live: false,
      missing_in_config: true,
      drift: true,
      live: liveRow,
    });
  }

  return {
    monitor_count: config.monitors.length,
    live_monitor_count: live.monitors.length,
    has_drift: hasDrift,
    monitors: perMonitor,
  };
}

export { parseUptimeKumaId };
