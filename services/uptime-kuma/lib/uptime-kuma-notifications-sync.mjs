import {
  buildNotificationIdList,
  notificationToSocketConfig,
  normalizeUptimeKumaNotificationsConfig,
  validateConfigNotification,
} from "./uptime-kuma-notifications-config.mjs";

/**
 * @param {Record<string, unknown>} row
 */
function liveNotificationName(row) {
  return typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
}

/**
 * @param {Record<string, unknown>} row
 */
function parseLiveNotificationId(row) {
  const id = row.id ?? row.notificationID;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {(line: string) => void} log
 */
export async function fetchLiveUptimeKumaNotifications(client, log) {
  const rows = await client.getNotificationList();
  log(`live notifications: ${rows.length}`);
  return rows;
}

/**
 * @param {import('./uptime-kuma-notifications-config.mjs').ConfigNotification} entry
 * @param {Record<string, unknown>[]} liveRows
 */
export function findLiveNotification(entry, liveRows) {
  const key = entry.name.trim().toLowerCase();
  return (
    liveRows.find((r) => liveNotificationName(r) === key) ??
    liveRows.find((r) => String(r.type ?? "").toLowerCase() === entry.type.toLowerCase()) ??
    null
  );
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {import('./uptime-kuma-notifications-config.mjs').ConfigNotification[]} notifications
 * @param {Record<string, unknown>[]} liveRows
 * @param {ReturnType<typeof import('../../../lib/package-vault-access.mjs').createPackageVaultAccess>} vault
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} opts
 */
export async function syncUptimeKumaNotifications(client, notifications, liveRows, vault, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});
  /** @type {Map<string, number>} */
  const liveIdsByConfigId = new Map();
  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const entry of notifications) {
    if (!entry.managed) {
      log(`skip notification ${entry.id} (not managed)`);
      continue;
    }
    try {
      validateConfigNotification(entry);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ ok: false, id: entry.id, error: msg });
      continue;
    }

    const live = findLiveNotification(entry, liveRows);
    const liveId = live ? parseLiveNotificationId(live) : null;
    let webhookUrl = "";
    if (entry.discord_webhook_vault_key) {
      await vault.unlock({});
      const secret = await vault.getSecret(entry.discord_webhook_vault_key, { optional: true });
      webhookUrl = typeof secret === "string" ? secret.trim() : "";
      if (!webhookUrl) {
        const msg = `vault key ${entry.discord_webhook_vault_key} missing for notification ${entry.id}`;
        log(`error: ${msg}`);
        results.push({ ok: false, id: entry.id, error: msg });
        continue;
      }
    }

    const configJson = notificationToSocketConfig(entry, webhookUrl);
    if (dryRun) {
      log(`dry-run: would ${liveId != null ? "edit" : "add"} notification ${entry.id}`);
      if (liveId != null) liveIdsByConfigId.set(entry.id, liveId);
      results.push({ ok: true, id: entry.id, action: liveId != null ? "edit" : "add", dryRun: true });
      continue;
    }

    try {
      if (liveId != null) {
        await client.editNotification(configJson, liveId);
        liveIdsByConfigId.set(entry.id, liveId);
        log(`updated notification ${entry.id} (uptime_kuma_id=${liveId})`);
        results.push({ ok: true, id: entry.id, action: "edit", uptime_kuma_id: liveId });
      } else {
        const resp = await client.addNotification(configJson);
        const newId = parseLiveNotificationId(resp) ?? Number(resp.id);
        if (Number.isFinite(newId) && newId > 0) {
          liveIdsByConfigId.set(entry.id, newId);
        }
        log(`added notification ${entry.id} (uptime_kuma_id=${newId ?? "unknown"})`);
        results.push({ ok: true, id: entry.id, action: "add", uptime_kuma_id: newId });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed notification ${entry.id}: ${msg}`);
      results.push({ ok: false, id: entry.id, error: msg });
    }
  }

  const ok = results.every((r) => r.ok !== false);
  return { ok, liveIdsByConfigId, results };
}

export { buildNotificationIdList };
