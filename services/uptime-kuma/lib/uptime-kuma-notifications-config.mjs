/** @typedef {{
 *   id: string;
 *   name: string;
 *   type: string;
 *   managed: boolean;
 *   discord_webhook_vault_key: string | null;
 *   discord_username: string | null;
 *   discord_prefix_message: string | null;
 *   smtp_host: string | null;
 *   smtp_port: number | null;
 *   smtp_secure: boolean;
 *   smtp_ignore_tls_error: boolean;
 *   smtp_username_env: string | null;
 *   smtp_password_vault_key: string | null;
 *   mail_from: string | null;
 *   mail_to: string | null;
 *   mail_cc: string;
 *   mail_bcc: string;
 *   custom_subject: string;
 *   use_mail_relay: boolean;
 *   apply_to_monitors: boolean;
 * }} ConfigNotification */

/** Secrets and site defaults resolved at sync time (vault, env, postfix-relay).
 * @typedef {{
 *   webhookUrl?: string;
 *   smtpHost?: string;
 *   smtpPort?: number;
 *   smtpUsername?: string;
 *   smtpPassword?: string;
 *   mailFrom?: string;
 * }} ResolvedNotificationSecrets */

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** @param {unknown} v @returns {string | null} */
function trimmedOrNull(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * @param {unknown} raw
 */
export function normalizeUptimeKumaNotificationsConfig(raw) {
  /** @type {ConfigNotification[]} */
  const notifications = Array.isArray(raw?.notifications)
    ? raw.notifications
        .filter((n) => isObject(n) && typeof n.id === "string" && n.id.trim())
        .map((n) => {
          const portRaw = Number(n.smtp_port);
          return {
            id: String(n.id).trim(),
            name: typeof n.name === "string" && n.name.trim() ? n.name.trim() : String(n.id),
            type: String(n.type ?? "discord").trim(),
            managed: n.managed === true,
            discord_webhook_vault_key: trimmedOrNull(n.discord_webhook_vault_key),
            discord_username:
              typeof n.discord_username === "string" && n.discord_username.trim()
                ? n.discord_username.trim()
                : "Uptime Kuma",
            discord_prefix_message:
              typeof n.discord_prefix_message === "string" ? n.discord_prefix_message : "",
            smtp_host: trimmedOrNull(n.smtp_host),
            smtp_port: Number.isFinite(portRaw) && portRaw > 0 ? Math.round(portRaw) : null,
            smtp_secure: n.smtp_secure === true,
            smtp_ignore_tls_error: n.smtp_ignore_tls_error === true,
            smtp_username_env: trimmedOrNull(n.smtp_username_env),
            smtp_password_vault_key: trimmedOrNull(n.smtp_password_vault_key),
            mail_from: trimmedOrNull(n.mail_from),
            mail_to: trimmedOrNull(n.mail_to),
            mail_cc: trimmedOrNull(n.mail_cc) ?? "",
            mail_bcc: trimmedOrNull(n.mail_bcc) ?? "",
            custom_subject: typeof n.custom_subject === "string" ? n.custom_subject : "",
            use_mail_relay: n.use_mail_relay === true,
            apply_to_monitors: n.apply_to_monitors !== false,
          };
        })
    : [];

  return {
    notifications,
    notificationsById: new Map(notifications.map((n) => [n.id, n])),
  };
}

/**
 * @param {ConfigNotification} entry
 */
export function validateConfigNotification(entry) {
  if (!entry.id) throw new Error("notification id is required");
  if (!entry.name) throw new Error(`notification ${entry.id}: name is required`);
  if (entry.type === "discord") {
    if (!entry.discord_webhook_vault_key) {
      throw new Error(
        `notification ${entry.id}: discord_webhook_vault_key is required for type discord`,
      );
    }
    return;
  }
  if (entry.type === "smtp") {
    if (!entry.mail_to) {
      throw new Error(`notification ${entry.id}: mail_to is required for type smtp`);
    }
    if (!entry.smtp_host && !entry.use_mail_relay) {
      throw new Error(
        `notification ${entry.id}: smtp_host is required for type smtp (or set use_mail_relay to use postfix-relay client_defaults)`,
      );
    }
    return;
  }
  throw new Error(`notification ${entry.id}: unsupported type ${entry.type}`);
}

/**
 * Build the Uptime Kuma socket.io notification payload.
 *
 * @param {ConfigNotification} entry
 * @param {string | ResolvedNotificationSecrets} secrets Discord accepts the legacy webhook
 *   URL string; SMTP takes a {@link ResolvedNotificationSecrets} object. Resolved values
 *   win over raw entry fields.
 */
export function notificationToSocketConfig(entry, secrets) {
  const resolved = /** @type {ResolvedNotificationSecrets} */ (
    isObject(secrets) ? secrets : {}
  );
  if (entry.type === "discord") {
    const webhookUrl = typeof secrets === "string" ? secrets : (resolved.webhookUrl ?? "");
    return {
      name: entry.name,
      type: "discord",
      isDefault: false,
      applyExisting: false,
      discordWebhookUrl: webhookUrl,
      discordUsername: entry.discord_username ?? "Uptime Kuma",
      discordPrefixMessage: entry.discord_prefix_message ?? "",
    };
  }
  if (entry.type === "smtp") {
    const host = resolved.smtpHost ?? entry.smtp_host;
    if (!host) {
      throw new Error(
        `notification ${entry.id}: no SMTP host resolved (set smtp_host or use_mail_relay)`,
      );
    }
    return {
      name: entry.name,
      type: "smtp",
      isDefault: false,
      applyExisting: false,
      smtpHost: host,
      smtpPort: resolved.smtpPort ?? entry.smtp_port ?? 25,
      smtpSecure: entry.smtp_secure,
      smtpIgnoreTLSError: entry.smtp_ignore_tls_error,
      smtpUsername: resolved.smtpUsername ?? "",
      smtpPassword: resolved.smtpPassword ?? "",
      smtpFrom: resolved.mailFrom ?? entry.mail_from ?? "",
      smtpTo: entry.mail_to,
      smtpCC: entry.mail_cc ?? "",
      smtpBCC: entry.mail_bcc ?? "",
      customSubject: entry.custom_subject ?? "",
    };
  }
  throw new Error(`notification ${entry.id}: unsupported type ${entry.type}`);
}

/**
 * Build notificationIDList for Uptime Kuma monitor payloads.
 *
 * @param {ConfigNotification[]} notifications
 * @param {Map<string, number>} liveIdsByConfigId
 * @param {string[] | undefined | null} monitorNotificationRefs
 */
export function buildNotificationIdList(notifications, liveIdsByConfigId, monitorNotificationRefs) {
  /** @type {Record<string, boolean>} */
  const list = {};
  const refs =
    Array.isArray(monitorNotificationRefs) && monitorNotificationRefs.length
      ? monitorNotificationRefs
      : notifications.filter((n) => n.apply_to_monitors).map((n) => n.id);

  for (const ref of refs) {
    const liveId = liveIdsByConfigId.get(ref);
    if (liveId != null && liveId > 0) {
      list[String(liveId)] = true;
    }
  }
  return list;
}
