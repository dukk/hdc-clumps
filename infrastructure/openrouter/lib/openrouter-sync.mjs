import {
  findLiveKeyForEntry,
  keyMetadataDrift,
  resolveKeyLimit,
  resolveKeyLimitReset,
} from "./openrouter-config.mjs";
import { writeInferenceKeyToVault } from "./vault-deps.mjs";

/**
 * @typedef {import('./openrouter-config.mjs').ConfigApiKey} ConfigApiKey
 * @typedef {import('./openrouter-api.mjs').OpenrouterApiKeyRow} OpenrouterApiKeyRow
 */

/**
 * @param {object} opts
 * @param {ConfigApiKey} opts.entry
 * @param {OpenrouterApiKeyRow | null} opts.live
 * @param {ReturnType<import('./openrouter-config.mjs').normalizeOpenrouterConfig>["defaults"]} opts.defaults
 */
export function planKeySync(opts) {
  const { entry, live, defaults } = opts;

  if (!entry.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      keyId: entry.id,
      name: entry.name,
      reason: "not managed",
      unchanged: true,
    };
  }

  if (!live) {
    return {
      action: /** @type {"create"} */ ("create"),
      keyId: entry.id,
      name: entry.name,
      payload: {
        name: entry.name,
        limit: resolveKeyLimit(entry, defaults),
        limit_reset: resolveKeyLimitReset(entry, defaults),
        include_byok_in_limit: entry.include_byok_in_limit,
        disabled: entry.disabled,
      },
      unchanged: false,
    };
  }

  const metadata = keyMetadataDrift(entry, live);
  if (metadata.has_drift) {
    return {
      action: /** @type {"update"} */ ("update"),
      keyId: entry.id,
      name: entry.name,
      hash: live.hash,
      payload: {
        name: entry.name,
        limit: resolveKeyLimit(entry, defaults),
        limit_reset: resolveKeyLimitReset(entry, defaults),
        include_byok_in_limit: entry.include_byok_in_limit,
        disabled: entry.disabled,
      },
      driftFields: metadata.fields,
      unchanged: false,
    };
  }

  return {
    action: /** @type {"unchanged"} */ ("unchanged"),
    keyId: entry.id,
    name: entry.name,
    hash: live.hash,
    unchanged: true,
  };
}

/**
 * Keys tracked in config (by hash) that are no longer in api_keys[] — prune candidates.
 * @param {ReturnType<import('./openrouter-config.mjs').normalizeOpenrouterConfig>} config
 * @param {OpenrouterApiKeyRow[]} liveKeys
 * @param {Set<string>} [configuredIds]
 */
export function planPruneKeys(config, liveKeys, configuredIds = null) {
  const ids = configuredIds ?? new Set(config.apiKeys.map((k) => k.id));
  const configuredHashes = new Set(
    config.apiKeys.filter((k) => ids.has(k.id) && k.openrouter_hash).map((k) => k.openrouter_hash)
  );

  /** @type {{ hash: string; name: string }[]} */
  const toDelete = [];
  for (const row of liveKeys) {
    if (!row.hash) continue;
    const inConfig = config.apiKeys.some(
      (k) => k.openrouter_hash === row.hash || (k.name && k.name === row.name)
    );
    if (inConfig) continue;
    if (!configuredHashes.has(row.hash)) continue;
    toDelete.push({ hash: row.hash, name: row.name });
  }
  return toDelete;
}

/**
 * @param {ReturnType<import('./openrouter-api.mjs').createOpenrouterClient>} api
 * @param {ReturnType<typeof planKeySync>} plan
 * @param {object} ctx
 * @param {ReturnType<import('./vault-deps.mjs').createOpenrouterVaultAccess>} ctx.vault
 * @param {ConfigApiKey} ctx.entry
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyKeySync(api, plan, ctx, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});
  const { vault, entry } = ctx;

  if (plan.action === "skip") {
    log(`skip ${plan.name} (${plan.reason})`);
    return { ok: true, action: "skip", keyId: plan.keyId, name: plan.name };
  }

  if (plan.action === "unchanged") {
    log(`unchanged ${plan.name}`);
    return {
      ok: true,
      action: "unchanged",
      keyId: plan.keyId,
      name: plan.name,
      hash: plan.hash,
    };
  }

  if (plan.action === "create") {
    try {
      if (dryRun) {
        log(`dry-run: would create API key ${plan.name}`);
        return { ok: true, action: "create", keyId: plan.keyId, name: plan.name, dryRun: true };
      }
      const created = await api.createKey(plan.payload);
      log(`created API key ${plan.name} (hash ${created.hash})`);
      if (created.key && entry.inference_api_key_vault_key) {
        await writeInferenceKeyToVault(vault, entry.inference_api_key_vault_key, created.key, {
          dryRun,
          log,
        });
      } else if (created.key && !entry.inference_api_key_vault_key) {
        log(
          `new key created for ${plan.name} — set inference_api_key_vault_key in config and run: node apps/hdc-cli/cli.mjs secrets set <KEY>`
        );
      } else if (!created.key) {
        log(`warning: create response did not include key string for ${plan.name}`);
      }
      return {
        ok: true,
        action: "create",
        keyId: plan.keyId,
        name: plan.name,
        hash: created.hash,
        vault_key: entry.inference_api_key_vault_key,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed create ${plan.name}: ${msg}`);
      return { ok: false, action: "create", keyId: plan.keyId, name: plan.name, error: msg };
    }
  }

  if (plan.action === "update") {
    try {
      if (dryRun) {
        log(`dry-run: would update API key ${plan.name} (${plan.driftFields?.join(", ")})`);
        return { ok: true, action: "update", keyId: plan.keyId, name: plan.name, dryRun: true };
      }
      await api.updateKey(plan.hash, plan.payload);
      log(`updated API key ${plan.name} (hash ${plan.hash})`);
      return {
        ok: true,
        action: "update",
        keyId: plan.keyId,
        name: plan.name,
        hash: plan.hash,
        drift_fields: plan.driftFields,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed update ${plan.name}: ${msg}`);
      return { ok: false, action: "update", keyId: plan.keyId, name: plan.name, error: msg };
    }
  }

  return { ok: true, action: "unknown", keyId: plan.keyId, name: plan.name };
}

/**
 * @param {ReturnType<import('./openrouter-api.mjs').createOpenrouterClient>} api
 * @param {{ hash: string; name: string }} target
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyKeyDelete(api, target, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});
  try {
    if (dryRun) {
      log(`dry-run: would delete API key ${target.name} (${target.hash})`);
      return { ok: true, action: "delete", hash: target.hash, dryRun: true };
    }
    await api.deleteKey(target.hash);
    log(`deleted API key ${target.name} (${target.hash})`);
    return { ok: true, action: "delete", hash: target.hash };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`failed delete ${target.name}: ${msg}`);
    return { ok: false, action: "delete", hash: target.hash, error: msg };
  }
}

/**
 * Build live lookup for maintain.
 * @param {OpenrouterApiKeyRow[]} liveKeys
 */
export function liveKeysByEntry(configKeys, liveKeys) {
  return new Map(
    configKeys.map((entry) => [entry.id, findLiveKeyForEntry(entry, liveKeys)])
  );
}
