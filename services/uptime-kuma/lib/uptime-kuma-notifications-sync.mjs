import { loadMailRelayClientDefaults } from "hdc/package/mail-relay-config.mjs";

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
 * @param {{ dryRun?: boolean; log?: (line: string) => void; env?: NodeJS.ProcessEnv; mailRelayDefaults?: () => { relay_hostname: string; relay_port: number; default_from: string } }} opts
 */
export async function syncUptimeKumaNotifications(client, notifications, liveRows, vault, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});
  const env = opts.env ?? process.env;
  const mailRelayDefaults = opts.mailRelayDefaults ?? (() => loadMailRelayClientDefaults({ env }));
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

    /** @type {import('./uptime-kuma-notifications-config.mjs').ResolvedNotificationSecrets} */
    const resolved = {};
    if (entry.type === "discord" && entry.discord_webhook_vault_key) {
      await vault.unlock({});
      const secret = await vault.getSecret(entry.discord_webhook_vault_key, { optional: true });
      resolved.webhookUrl = typeof secret === "string" ? secret.trim() : "";
      if (!resolved.webhookUrl) {
        const msg = `vault key ${entry.discord_webhook_vault_key} missing for notification ${entry.id}`;
        log(`error: ${msg}`);
        results.push({ ok: false, id: entry.id, error: msg });
        continue;
      }
    }
    if (entry.type === "smtp") {
      if (entry.use_mail_relay && (!entry.smtp_host || !entry.mail_from)) {
        const relay = mailRelayDefaults();
        if (!entry.smtp_host) {
          resolved.smtpHost = relay.relay_hostname;
          resolved.smtpPort = entry.smtp_port ?? relay.relay_port;
        }
        if (!entry.mail_from) resolved.mailFrom = relay.default_from;
      }
      if (entry.smtp_username_env) {
        resolved.smtpUsername = String(env[entry.smtp_username_env] ?? "").trim();
      }
      if (entry.smtp_password_vault_key) {
        await vault.unlock({});
        const secret = await vault.getSecret(entry.smtp_password_vault_key, { optional: true });
        resolved.smtpPassword = typeof secret === "string" ? secret.trim() : "";
        if (!resolved.smtpPassword) {
          const msg = `vault key ${entry.smtp_password_vault_key} missing for notification ${entry.id}`;
          log(`error: ${msg}`);
          results.push({ ok: false, id: entry.id, error: msg });
          continue;
        }
      }
    }

    const configJson = notificationToSocketConfig(entry, resolved);
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
