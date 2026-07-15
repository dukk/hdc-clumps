import { mailBlockFromService } from "hdc/package/app-mail-render.mjs";
import { loadMailRelayAppSettings, mailEnabledFromConfig } from "hdc/package/mail-relay-settings.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
export function deepMergeObjects(target, source) {
  const out = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (isObject(val) && isObject(out[key])) {
      out[key] = deepMergeObjects(/** @type {Record<string, unknown>} */ (out[key]), val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Strip secrets before writing system_config to hdc-private config.
 * @param {unknown} live
 */
export function sanitizeSystemConfigForStorage(live) {
  if (!isObject(live)) return null;
  const copy = structuredClone(live);

  const notifications = isObject(copy.notifications) ? copy.notifications : {};
  const smtp = isObject(notifications.smtp) ? notifications.smtp : {};
  const transport = isObject(smtp.transport) ? smtp.transport : {};
  if (Object.keys(transport).length || isObject(smtp)) {
    copy.notifications = {
      ...notifications,
      smtp: {
        ...smtp,
        transport: {
          ...transport,
          password: "",
        },
      },
    };
  }

  if (isObject(copy.oauth)) {
    copy.oauth = {
      ...copy.oauth,
      clientId: "",
      clientSecret: "",
    };
  }

  return copy;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare configured system_config vs live; returns drifted top-level section names.
 * @param {unknown} configured
 * @param {unknown} live
 */
export function diffSystemConfigSections(configured, live) {
  if (!isObject(configured)) {
    return isObject(live) ? Object.keys(live) : [];
  }
  if (!isObject(live)) return Object.keys(configured);

  /** @type {string[]} */
  const drift = [];
  const keys = new Set([...Object.keys(configured), ...Object.keys(live)]);
  for (const key of keys) {
    const c = configured[key];
    const l = live[key];
    if (!jsonEqual(c, l)) drift.push(key);
  }
  return drift.sort();
}

/**
 * @param {unknown} systemConfig
 */
export function smtpSummaryFromSystemConfig(systemConfig) {
  if (!isObject(systemConfig)) {
    return { enabled: false, host: "", port: null, from: "" };
  }
  const notifications = isObject(systemConfig.notifications) ? systemConfig.notifications : {};
  const smtp = isObject(notifications.smtp) ? notifications.smtp : {};
  const transport = isObject(smtp.transport) ? smtp.transport : {};
  return {
    enabled: smtp.enabled === true,
    host: typeof transport.host === "string" ? transport.host : "",
    port: typeof transport.port === "number" ? transport.port : null,
    from: typeof smtp.from === "string" ? smtp.from : "",
  };
}

/**
 * Apply postfix-relay SMTP overlay onto a system config object (mutates copy).
 * @param {Record<string, unknown>} systemConfig
 * @param {Record<string, unknown>} immich
 */
export function applyMailRelayToSystemConfig(systemConfig, immich) {
  const mail = mailBlockFromService(immich);
  if (!mailEnabledFromConfig(mail)) return systemConfig;

  const relay = loadMailRelayAppSettings();
  const from =
    typeof mail.from === "string" && mail.from.trim() ? mail.from.trim() : relay.from;
  const replyTo = typeof mail.reply_to === "string" ? mail.reply_to : "";

  const notifications = isObject(systemConfig.notifications)
    ? { ...systemConfig.notifications }
    : {};
  const smtp = isObject(notifications.smtp) ? { ...notifications.smtp } : {};
  const transport = isObject(smtp.transport) ? { ...smtp.transport } : {};

  notifications.smtp = {
    ...smtp,
    enabled: true,
    from,
    replyTo,
    transport: {
      ...transport,
      host: relay.host,
      port: relay.port,
      secure: false,
      username: "",
      password: "",
      ignoreCert: false,
    },
  };
  systemConfig.notifications = notifications;
  return systemConfig;
}

/**
 * Set server.externalDomain from immich.public_url when configured.
 * @param {Record<string, unknown>} systemConfig
 * @param {Record<string, unknown>} immich
 */
export function applyPublicUrlToSystemConfig(systemConfig, immich) {
  const publicUrl =
    typeof immich.public_url === "string" && immich.public_url.trim()
      ? immich.public_url.trim()
      : "";
  if (!publicUrl) return systemConfig;

  const server = isObject(systemConfig.server) ? { ...systemConfig.server } : {};
  server.externalDomain = publicUrl;
  systemConfig.server = server;
  return systemConfig;
}

/**
 * Build PUT payload: live base + configured system_config merge + mail/public_url overlays.
 * @param {unknown} live
 * @param {Record<string, unknown>} immich
 */
export function mergeSystemConfigForMaintain(live, immich) {
  if (!isObject(live)) {
    throw new Error("live system-config is not an object");
  }
  let merged = structuredClone(live);

  const configured = immich.system_config;
  if (isObject(configured)) {
    merged = deepMergeObjects(merged, configured);
  }

  applyMailRelayToSystemConfig(merged, immich);
  applyPublicUrlToSystemConfig(merged, immich);
  return merged;
}

/**
 * @param {unknown} before
 * @param {unknown} after
 */
export function systemConfigChanged(before, after) {
  return !jsonEqual(before, after);
}
