import {
  findLiveKeyForEntry,
  keyMetadataDrift,
  liveKeyToConfig,
} from "./openrouter-config.mjs";
import { resolveOpenrouterApiKey } from "./vault-deps.mjs";

/**
 * @param {ReturnType<import('./openrouter-api.mjs').createOpenrouterClient>} api
 * @param {(line: string) => void} [log]
 */
export async function fetchLiveOpenrouterState(api, log = () => {}) {
  log("fetching account credits");
  const credits = await api.getCredits();
  log(`credits: purchased=${credits.total_credits} used=${credits.total_usage}`);

  log("fetching API keys (management)");
  const keys = await api.listKeys();
  log(`keys: ${keys.length} in account`);

  return { credits, keys };
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./openrouter-config.mjs').normalizeOpenrouterConfig>} opts.config
 * @param {{ credits: import('./openrouter-api.mjs').OpenrouterCredits; keys: import('./openrouter-api.mjs').OpenrouterApiKeyRow[] }} opts.live
 * @param {Record<string, import('./openrouter-api.mjs').OpenrouterApiKeyRow | null>} [opts.inferenceStats]
 * @param {string | undefined} [opts.keyIdFilter]
 */
export function collectOpenrouterState(opts) {
  const { config, live, inferenceStats = {}, keyIdFilter } = opts;
  const onlyId = keyIdFilter ? keyIdFilter.trim() : null;

  let configKeys = config.apiKeys;
  if (onlyId) {
    const one = config.keysById.get(onlyId);
    if (!one) throw new Error(`API key id not found in config: ${onlyId}`);
    configKeys = [one];
  }

  const liveByHash = new Map(live.keys.filter((k) => k.hash).map((k) => [k.hash, k]));
  const trackedHashes = new Set(
    config.apiKeys.filter((k) => k.openrouter_hash).map((k) => k.openrouter_hash)
  );
  const configNames = new Set(configKeys.map((k) => k.name));
  const configHashes = new Set(
    configKeys.filter((k) => k.openrouter_hash).map((k) => k.openrouter_hash)
  );

  const remaining = live.credits.total_credits - live.credits.total_usage;
  const lowBalance = remaining < config.credits.low_balance_usd;

  /** @type {Record<string, unknown>[]} */
  const api_keys = [];
  let hasDrift = lowBalance;

  for (const entry of configKeys) {
    const liveRow = findLiveKeyForEntry(entry, live.keys);
    const metadata = keyMetadataDrift(entry, liveRow);
    const missingManaged = entry.managed && !liveRow;
    const entryDrift = metadata.has_drift || missingManaged;
    if (entryDrift) hasDrift = true;

    const inference = entry.inference_api_key_vault_key
      ? (inferenceStats[entry.id] ?? null)
      : null;
    const vaultMissing = Boolean(
      entry.inference_api_key_vault_key && !(entry.id in inferenceStats)
    );

    api_keys.push({
      id: entry.id,
      name: entry.name,
      managed: entry.managed,
      consumer: entry.consumer,
      in_live: Boolean(liveRow),
      openrouter_hash: liveRow?.hash ?? entry.openrouter_hash,
      missing_in_live: !liveRow,
      metadata_drift: metadata.has_drift ? metadata.fields : [],
      has_drift: entryDrift,
      limit_usd: entry.limit_usd,
      live_limit_usd: liveRow?.limit ?? null,
      disabled: entry.disabled,
      live_disabled: liveRow?.disabled ?? null,
      inference_api_key_vault_key: entry.inference_api_key_vault_key,
      vault_missing: vaultMissing,
      inference_stats: inference
        ? {
            usage: inference.usage,
            usage_daily: inference.usage_daily,
            usage_monthly: inference.usage_monthly,
            limit_remaining: inference.limit_remaining,
          }
        : null,
      notes: entry.notes,
    });
  }

  /** @type {Record<string, unknown>[]} */
  const extra_in_live = [];
  for (const row of live.keys) {
    if (!row.hash) continue;
    if (configHashes.has(row.hash)) continue;
    if (row.name && configNames.has(row.name)) continue;
    if (trackedHashes.has(row.hash)) continue;
    hasDrift = true;
    extra_in_live.push({
      openrouter_hash: row.hash,
      name: row.name,
      limit_usd: row.limit,
      usage: row.usage,
      suggested_config_entry: liveKeyToConfig(row),
    });
  }

  return {
    credits: {
      total_credits: live.credits.total_credits,
      total_usage: live.credits.total_usage,
      remaining_usd: remaining,
      low_balance_usd: config.credits.low_balance_usd,
      low_balance: lowBalance,
    },
    api_keys,
    extra_in_live,
    has_drift: hasDrift,
    live_key_count: live.keys.length,
    configured_key_count: config.apiKeys.length,
    key_id_filter: onlyId,
  };
}

/**
 * @param {ReturnType<import('./openrouter-config.mjs').normalizeOpenrouterConfig>} config
 * @param {ReturnType<import('./openrouter-api.mjs').createOpenrouterClient>} api
 * @param {ReturnType<typeof createOpenrouterVaultAccess>} vault
 * @param {(line: string) => void} [log]
 */
export async function fetchInferenceStatsForConfig(config, api, vault, log = () => {}) {
  /** @type {Record<string, import('./openrouter-api.mjs').OpenrouterApiKeyRow | null | undefined>} */
  const stats = {};

  for (const entry of config.apiKeys) {
    if (!entry.inference_api_key_vault_key) continue;
    try {
      const inferenceKey = await resolveOpenrouterApiKey(vault, entry.inference_api_key_vault_key, {
        required: false,
      });
      if (!inferenceKey) {
        log(`inference stats ${entry.id}: vault key missing (${entry.inference_api_key_vault_key})`);
        continue;
      }
      log(`inference stats ${entry.id}: probing GET /key`);
      stats[entry.id] = await api.getKeyStats(inferenceKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`inference stats ${entry.id}: failed (${msg})`);
      stats[entry.id] = null;
    }
  }

  return stats;
}
