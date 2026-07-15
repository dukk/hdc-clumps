import { OPENROUTER_MANAGEMENT_API_KEY_VAULT_KEY } from "./vault-deps.mjs";

/**
 * @typedef {{
 *   id: string;
 *   name: string;
 *   managed: boolean;
 *   inference_api_key_vault_key: string | null;
 *   openrouter_hash: string | null;
 *   limit_usd: number | null;
 *   limit_reset: string | null;
 *   include_byok_in_limit: boolean;
 *   disabled: boolean;
 *   consumer: string | null;
 *   notes: string | null;
 * }} ConfigApiKey
 */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} value
 */
export function slugifyId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * @param {string} name
 */
export function apiKeyIdFromName(name) {
  return slugifyId(name);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseLimitUsd(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {import('./openrouter-api.mjs').OpenrouterApiKeyRow} row
 * @param {ConfigApiKey | null} [existing]
 */
export function liveKeyToConfig(row, existing = null) {
  return /** @type {ConfigApiKey} */ ({
    id: existing?.id || apiKeyIdFromName(row.name || row.hash),
    name: row.name || existing?.name || "",
    managed: existing?.managed ?? false,
    inference_api_key_vault_key: existing?.inference_api_key_vault_key ?? null,
    openrouter_hash: row.hash || existing?.openrouter_hash || null,
    limit_usd: row.limit ?? existing?.limit_usd ?? null,
    limit_reset: row.limit_reset ?? existing?.limit_reset ?? null,
    include_byok_in_limit: row.include_byok_in_limit ?? existing?.include_byok_in_limit ?? false,
    disabled: row.disabled ?? existing?.disabled ?? false,
    consumer: existing?.consumer ?? null,
    notes: existing?.notes ?? null,
  });
}

/**
 * Resolve effective limit for an entry using defaults.
 * @param {ConfigApiKey} entry
 * @param {ReturnType<typeof normalizeOpenrouterConfig>["defaults"]} defaults
 */
export function resolveKeyLimit(entry, defaults) {
  if (entry.limit_usd != null) return entry.limit_usd;
  return defaults.limit_usd;
}

/**
 * @param {ConfigApiKey} entry
 * @param {ReturnType<typeof normalizeOpenrouterConfig>["defaults"]} defaults
 */
export function resolveKeyLimitReset(entry, defaults) {
  if (entry.limit_reset != null) return entry.limit_reset;
  return defaults.limit_reset;
}

/**
 * @param {ConfigApiKey} entry
 * @param {import('./openrouter-api.mjs').OpenrouterApiKeyRow | null} live
 */
export function keyMetadataDrift(entry, live) {
  if (!live) return { has_drift: true, fields: ["missing_in_live"] };

  /** @type {string[]} */
  const fields = [];
  const configLimit = entry.limit_usd;
  const liveLimit = live.limit;
  if (configLimit !== liveLimit) fields.push("limit_usd");
  if ((entry.limit_reset ?? null) !== (live.limit_reset ?? null)) fields.push("limit_reset");
  if (entry.include_byok_in_limit !== live.include_byok_in_limit) fields.push("include_byok_in_limit");
  if (entry.disabled !== (live.disabled === true)) fields.push("disabled");
  if (entry.name && live.name && entry.name !== live.name) fields.push("name");

  return { has_drift: fields.length > 0, fields };
}

/**
 * @param {ConfigApiKey} entry
 * @param {import('./openrouter-api.mjs').OpenrouterApiKeyRow[]} liveKeys
 */
export function findLiveKeyForEntry(entry, liveKeys) {
  if (entry.openrouter_hash) {
    const byHash = liveKeys.find((k) => k.hash === entry.openrouter_hash);
    if (byHash) return byHash;
  }
  if (entry.name) {
    const byName = liveKeys.find((k) => k.name === entry.name);
    if (byName) return byName;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeOpenrouterConfig(cfg) {
  const or = isObject(cfg.openrouter) ? cfg.openrouter : {};
  const auth = isObject(or.auth) ? or.auth : {};
  const managementVaultKey =
    typeof auth.management_api_key_vault_key === "string" &&
    auth.management_api_key_vault_key.trim()
      ? auth.management_api_key_vault_key.trim()
      : OPENROUTER_MANAGEMENT_API_KEY_VAULT_KEY;

  const apiBase =
    typeof or.api_base_url === "string" && or.api_base_url.trim()
      ? or.api_base_url.trim().replace(/\/$/, "")
      : "https://openrouter.ai/api/v1";

  const defaultsRaw = isObject(cfg.defaults) ? cfg.defaults : {};
  const defaults = {
    limit_usd: parseLimitUsd(defaultsRaw.limit_usd),
    limit_reset:
      typeof defaultsRaw.limit_reset === "string" && defaultsRaw.limit_reset.trim()
        ? defaultsRaw.limit_reset.trim()
        : null,
    include_byok_in_limit: defaultsRaw.include_byok_in_limit === true,
  };

  const creditsRaw = isObject(cfg.credits) ? cfg.credits : {};
  const lowBalanceUsd = parseLimitUsd(creditsRaw.low_balance_usd) ?? 5;

  /** @type {ConfigApiKey[]} */
  const apiKeys = [];
  const list = Array.isArray(cfg.api_keys) ? cfg.api_keys : [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!id || !name) continue;

    apiKeys.push({
      id,
      name,
      managed: raw.managed === true,
      inference_api_key_vault_key:
        typeof raw.inference_api_key_vault_key === "string" &&
        raw.inference_api_key_vault_key.trim()
          ? raw.inference_api_key_vault_key.trim()
          : null,
      openrouter_hash:
        typeof raw.openrouter_hash === "string" && raw.openrouter_hash.trim()
          ? raw.openrouter_hash.trim()
          : null,
      limit_usd: parseLimitUsd(raw.limit_usd),
      limit_reset:
        typeof raw.limit_reset === "string" && raw.limit_reset.trim()
          ? raw.limit_reset.trim()
          : null,
      include_byok_in_limit:
        raw.include_byok_in_limit === true
          ? true
          : raw.include_byok_in_limit === false
            ? false
            : defaults.include_byok_in_limit,
      disabled: raw.disabled === true,
      consumer: typeof raw.consumer === "string" ? raw.consumer.trim() || null : null,
      notes: typeof raw.notes === "string" ? raw.notes.trim() || null : null,
    });
  }

  return {
    apiBase,
    managementVaultKey,
    defaults,
    credits: { low_balance_usd: lowBalanceUsd },
    apiKeys,
    keysById: new Map(apiKeys.map((k) => [k.id, k])),
    keysByHash: new Map(apiKeys.filter((k) => k.openrouter_hash).map((k) => [k.openrouter_hash, k])),
    keysByName: new Map(apiKeys.map((k) => [k.name, k])),
  };
}
