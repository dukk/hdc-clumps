/** @typedef {{
 *   id: string;
 *   name: string;
 *   type: string;
 *   managed: boolean;
 *   discord_webhook_vault_key: string | null;
 *   discord_username: string | null;
 *   discord_prefix_message: string | null;
 *   apply_to_monitors: boolean;
 * }} ConfigNotification */

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} raw
 */
export function normalizeUptimeKumaNotificationsConfig(raw) {
  /** @type {ConfigNotification[]} */
  const notifications = Array.isArray(raw?.notifications)
    ? raw.notifications
        .filter((n) => isObject(n) && typeof n.id === "string" && n.id.trim())
        .map((n) => ({
          id: String(n.id).trim(),
          name: typeof n.name === "string" && n.name.trim() ? n.name.trim() : String(n.id),
          type: String(n.type ?? "discord").trim(),
          managed: n.managed === true,
          discord_webhook_vault_key:
            typeof n.discord_webhook_vault_key === "string" && n.discord_webhook_vault_key.trim()
              ? n.discord_webhook_vault_key.trim()
              : null,
          discord_username:
            typeof n.discord_username === "string" && n.discord_username.trim()
              ? n.discord_username.trim()
              : "Uptime Kuma",
          discord_prefix_message:
            typeof n.discord_prefix_message === "string" ? n.discord_prefix_message : "",
          apply_to_monitors: n.apply_to_monitors !== false,
        }))
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
  if (entry.type === "discord" && !entry.discord_webhook_vault_key) {
    throw new Error(`notification ${entry.id}: discord_webhook_vault_key is required for type discord`);
  }
}

/**
 * @param {ConfigNotification} entry
 * @param {string} webhookUrl
 */
export function notificationToSocketConfig(entry, webhookUrl) {
  if (entry.type === "discord") {
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
