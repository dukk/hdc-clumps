import { normalizeWazuhLogCollectionEntries } from "hdc/package/wazuh-log-collection.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Resolve Wazuh agent localfile entries for nginx-waf guests.
 *
 * @param {Record<string, unknown>} cfg
 * @returns {{ location: string; log_format: string }[]}
 */
export function resolveNginxWafWazuhLogCollection(cfg) {
  const defaults = isObject(cfg.defaults) ? cfg.defaults : {};
  const wazuh = isObject(defaults.wazuh) ? defaults.wazuh : {};
  const explicit = normalizeWazuhLogCollectionEntries(wazuh.log_collection);
  if (explicit.length) return explicit;

  const nw = isObject(defaults.nginx_waf) ? defaults.nginx_waf : {};
  const ms = isObject(nw.modsecurity) ? nw.modsecurity : {};
  const auditLog =
    typeof ms.audit_log === "string" && ms.audit_log.trim()
      ? ms.audit_log.trim()
      : "/var/log/nginx/modsec_audit.log";

  /** @type {{ location: string; log_format: string }[]} */
  const entries = [
    { location: "/var/log/nginx/access.log", log_format: "syslog" },
    { location: "/var/log/nginx/error.log", log_format: "syslog" },
  ];
  if (ms.enabled !== false) {
    entries.push({ location: auditLog, log_format: "json" });
  }
  return entries;
}
