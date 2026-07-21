/**
 * Sanitize Home Assistant API payloads before writing to hdc-private.
 */

const SECRET_KEY_RE =
  /^(password|passwd|api_key|apikey|token|secret|access_token|refresh_token|client_secret|auth_token|bearer)$/i;

const GEO_KEYS = new Set(["latitude", "longitude", "elevation"]);

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Recursively redact secret-ish keys; replace values with "".
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSecretKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretKeys(item));
  }
  if (!isObject(value)) {
    return value;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "";
      continue;
    }
    out[key] = redactSecretKeys(val);
  }
  return out;
}

/**
 * Sanitize GET /api/config for storage (drop precise geo).
 * @param {unknown} core
 * @returns {Record<string, unknown> | null}
 */
export function sanitizeHaCoreConfig(core) {
  if (!isObject(core)) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, val] of Object.entries(core)) {
    if (GEO_KEYS.has(key)) {
      out[key] = "redacted";
      continue;
    }
    out[key] = redactSecretKeys(val);
  }
  return out;
}

/**
 * Sanitize automation/script/scene config body.
 * @param {unknown} body
 * @returns {unknown}
 */
export function sanitizeHaYamlConfigBody(body) {
  return redactSecretKeys(body);
}

/**
 * Project a live config_entries fragment to storage shape (metadata only).
 * @param {unknown} entry
 * @returns {Record<string, unknown> | null}
 */
export function sanitizeConfigEntry(entry) {
  if (!isObject(entry)) return null;
  const domain = typeof entry.domain === "string" ? entry.domain.trim() : "";
  if (!domain) return null;
  return {
    entry_id: typeof entry.entry_id === "string" ? entry.entry_id : null,
    title: typeof entry.title === "string" ? entry.title : "",
    state: typeof entry.state === "string" ? entry.state : null,
    source: typeof entry.source === "string" ? entry.source : null,
    disabled_by: entry.disabled_by ?? null,
    reason: typeof entry.reason === "string" ? entry.reason : null,
    supports_options: Boolean(entry.supports_options),
    supports_unload: Boolean(entry.supports_unload),
    supports_reconfigure: Boolean(entry.supports_reconfigure),
    pref_disable_new_entities: Boolean(entry.pref_disable_new_entities),
    pref_disable_polling: Boolean(entry.pref_disable_polling),
  };
}
