import { monitorListRowsFromPayload } from "./uptime-kuma-api.mjs";

/** Uptime Kuma heartbeat status: 0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE */
export const UK_HEARTBEAT_DOWN = 0;
export const UK_HEARTBEAT_UP = 1;
export const UK_HEARTBEAT_PENDING = 2;
export const UK_HEARTBEAT_MAINTENANCE = 3;

/**
 * @param {Record<string, unknown[]>} heartbeatList
 * @param {string | number} monitorId
 * @returns {Record<string, unknown> | null}
 */
export function latestHeartbeatForMonitor(heartbeatList, monitorId) {
  const beats = heartbeatList?.[String(monitorId)];
  if (!Array.isArray(beats) || beats.length === 0) return null;
  return /** @type {Record<string, unknown>} */ (beats[0]);
}

/**
 * @param {unknown} row
 */
function monitorRowId(row) {
  if (!row || typeof row !== "object") return null;
  const id = /** @type {Record<string, unknown>} */ (row).id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && id.trim()) return Number(id) || id.trim();
  return null;
}

/**
 * @param {unknown} row
 */
function monitorTargetLabel(row) {
  if (!row || typeof row !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const url = typeof r.url === "string" ? r.url.trim() : "";
  if (url) return url;
  const hostname = typeof r.hostname === "string" ? r.hostname.trim() : "";
  if (hostname) return hostname;
  const port = r.port;
  if (hostname && port != null) return `${hostname}:${port}`;
  return null;
}

/**
 * @param {unknown[]} monitorRows
 * @param {Record<string, unknown[]>} heartbeatList
 */
export function collectFailingFromHeartbeatData(monitorRows, heartbeatList) {
  /** @type {Record<string, unknown>[]} */
  const failing = [];

  for (const row of monitorRows) {
    const monitorId = monitorRowId(row);
    if (monitorId == null) continue;
    const active = /** @type {Record<string, unknown>} */ (row).active;
    if (active === false) continue;

    const hb = latestHeartbeatForMonitor(heartbeatList, monitorId);
    if (!hb) continue;

    const status = Number(hb.status);
    if (status !== UK_HEARTBEAT_DOWN) continue;

    const name =
      typeof /** @type {Record<string, unknown>} */ (row).name === "string"
        ? String(/** @type {Record<string, unknown>} */ (row).name)
        : `monitor-${monitorId}`;

    failing.push({
      monitor_id: monitorId,
      name,
      type: typeof /** @type {Record<string, unknown>} */ (row).type === "string"
        ? /** @type {Record<string, unknown>} */ (row).type
        : null,
      target: monitorTargetLabel(row),
      status: "down",
      heartbeat_status: status,
      msg: typeof hb.msg === "string" ? hb.msg : null,
      ping: hb.ping ?? null,
      time: typeof hb.time === "string" ? hb.time : null,
    });
  }

  failing.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return {
    monitor_count: monitorRows.length,
    failing_count: failing.length,
    failing,
  };
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {(line: string) => void} [log]
 */
export async function fetchFailingUptimeKumaMonitors(client, log = () => {}) {
  await client.login();
  log("connected to Uptime Kuma API (socket.io)");
  const monitorRows = monitorListRowsFromPayload(await client.getMonitorList());
  const heartbeatList = await client.getHeartbeatList();
  log(`live monitors: ${monitorRows.length}`);
  return collectFailingFromHeartbeatData(monitorRows, heartbeatList);
}
