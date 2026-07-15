import {
  loadMailRelayAppSettings,
  mailEnabledFromConfig,
} from "hdc/package/mail-relay-settings.mjs";
import { loadMailRelayClientDefaults } from "hdc/package/mail-relay-config.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Prefer bracketed relay IP from postfix-relay client_defaults for container reachability.
 * @param {import("../../../lib/mail-relay-config.mjs").MailRelayClientDefaults} relayDefaults
 */
function defaultSmtpHost(relayDefaults) {
  const relayhost = typeof relayDefaults.relayhost === "string" ? relayDefaults.relayhost.trim() : "";
  const bracketed = /^\[([^\]]+)\]$/.exec(relayhost);
  if (bracketed?.[1]) return bracketed[1];
  return relayDefaults.relay_hostname;
}

/**
 * @param {unknown} toRaw
 * @returns {string[]}
 */
function normalizeMailToList(toRaw) {
  if (Array.isArray(toRaw)) {
    return toRaw
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof toRaw === "string" && toRaw.trim()) return [toRaw.trim()];
  return [];
}

/**
 * Resolved Wazuh mail settings for manager alerts and OpenSearch notification channels.
 *
 * @typedef {object} WazuhMailSettings
 * @property {boolean} enabled
 * @property {string} smtp_server
 * @property {number} smtp_port
 * @property {string} email_from
 * @property {string[]} email_to
 * @property {number} alert_level
 * @property {number} max_per_hour
 * @property {{ enabled: boolean; smtp_sender_id: string; email_channel_id: string; channel_name: string }} notifications
 */

/**
 * @param {Record<string, unknown>} cfg Clump config (merged defaults).
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {WazuhMailSettings | null}
 */
export function resolveWazuhMailConfig(cfg, opts = {}) {
  const defaults = isObject(cfg.defaults) ? cfg.defaults : {};
  const mail = isObject(defaults.mail) ? defaults.mail : {};
  if (!mailEnabledFromConfig(mail)) return null;

  const to = normalizeMailToList(mail.to);
  if (!to.length) return null;

  const relayDefaults = loadMailRelayClientDefaults({ env: opts.env });
  const relay = loadMailRelayAppSettings({ env: opts.env });
  const smtp_server =
    typeof mail.smtp_host === "string" && mail.smtp_host.trim()
      ? mail.smtp_host.trim()
      : defaultSmtpHost(relayDefaults);

  const email_from =
    typeof mail.from === "string" && mail.from.trim() ? mail.from.trim() : relay.from;

  const alert_level =
    typeof mail.alert_level === "number" && Number.isFinite(mail.alert_level)
      ? Math.round(mail.alert_level)
      : 10;
  const max_per_hour =
    typeof mail.max_per_hour === "number" && Number.isFinite(mail.max_per_hour)
      ? Math.round(mail.max_per_hour)
      : 12;

  const notif = isObject(mail.notifications) ? mail.notifications : {};
  const notificationsEnabled = notif.enabled !== false;

  return {
    enabled: true,
    smtp_server,
    smtp_port: relay.port,
    email_from,
    email_to: to,
    alert_level,
    max_per_hour,
    notifications: {
      enabled: notificationsEnabled,
      smtp_sender_id:
        typeof notif.smtp_sender_id === "string" && notif.smtp_sender_id.trim()
          ? notif.smtp_sender_id.trim()
          : "hdc-postfix-relay",
      email_channel_id:
        typeof notif.email_channel_id === "string" && notif.email_channel_id.trim()
          ? notif.email_channel_id.trim()
          : "hdc-wazuh-alerts",
      channel_name:
        typeof notif.channel_name === "string" && notif.channel_name.trim()
          ? notif.channel_name.trim()
          : "HDC Wazuh alerts",
    },
  };
}
