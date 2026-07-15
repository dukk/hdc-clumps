import { normalizeWazuhLogCollectionEntries } from "hdc/package/wazuh-log-collection.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} cfg
 * @returns {{ location: string; log_format: string }[]}
 */
export function resolveCrowdsecWazuhLogCollection(cfg) {
  const defaults = isObject(cfg.defaults) ? cfg.defaults : {};
  const wazuh = isObject(defaults.wazuh) ? defaults.wazuh : {};
  const explicit = normalizeWazuhLogCollectionEntries(wazuh.log_collection);
  if (explicit.length) return explicit;

  return [
    { location: "/var/log/crowdsec.log", log_format: "syslog" },
    { location: "/var/log/crowdsec-api.log", log_format: "syslog" },
  ];
}
