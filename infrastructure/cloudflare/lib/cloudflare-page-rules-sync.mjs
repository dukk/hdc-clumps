import {
  configPageRuleToNormalized,
  livePageRuleToNormalized,
  normalizedToPageRuleBody,
  pageRuleMatchKey,
  pageRulesNeedUpdate,
} from "./cloudflare-page-rules-config.mjs";

/** @typedef {import('./cloudflare-page-rules-config.mjs').ConfigPageRule} ConfigPageRule */
/** @typedef {import('./cloudflare-page-rules-config.mjs').NormalizedPageRule} NormalizedPageRule */
/** @typedef {import('./cloudflare-api.mjs').CfPageRule} CfPageRule */

/**
 * @param {ConfigPageRule[]} desired
 * @param {CfPageRule[]} live
 * @param {boolean} [prune]
 */
export function planPageRuleSync(desired, live, prune = false) {
  /** @type {Map<string, { desired: ConfigPageRule; normalized: NormalizedPageRule; key: string }>} */
  const desiredMap = new Map();
  for (const d of desired) {
    const normalized = configPageRuleToNormalized(d);
    let key = pageRuleMatchKey(normalized);
    const cfId = typeof d.cf_id === "string" ? d.cf_id.trim() : "";
    if (cfId) key = `${key}|${cfId}`;
    if (desiredMap.has(key)) {
      throw new Error(`Duplicate desired page rule key in config: ${key.replace(/\|/g, " ")}`);
    }
    desiredMap.set(key, { desired: d, normalized, key });
  }

  /** @type {Map<string, { live: CfPageRule; normalized: NormalizedPageRule; key: string; cfId: string }>} */
  const liveByKey = new Map();
  /** @type {Map<string, { live: CfPageRule; normalized: NormalizedPageRule; key: string; cfId: string }>} */
  const liveByCfId = new Map();
  for (const l of live) {
    const normalized = livePageRuleToNormalized(l);
    let key = pageRuleMatchKey(normalized);
    const cfId = l.id;
    if (liveByKey.has(key)) {
      if (!cfId) {
        throw new Error(`Duplicate live page rule key in Cloudflare: ${key.replace(/\|/g, " ")}`);
      }
      key = `${key}|${cfId}`;
    }
    const item = { live: l, normalized, key, cfId };
    liveByKey.set(key, item);
    if (cfId) {
      if (liveByCfId.has(cfId)) {
        throw new Error(`Duplicate live page rule id in Cloudflare: ${cfId}`);
      }
      liveByCfId.set(cfId, item);
    }
  }

  /** @type {{ key: string; desired: ConfigPageRule }[]} */
  const create = [];
  /** @type {{ key: string; desired: ConfigPageRule; live: CfPageRule; cfId: string }[]} */
  const update = [];
  /** @type {{ key: string; live: CfPageRule; cfId: string }[]} */
  const del = [];
  /** @type {string[]} */
  const unchanged = [];

  /** @type {Set<string>} */
  const matchedLiveKeys = new Set();

  for (const [key, { desired: d, normalized }] of desiredMap) {
    let existing = null;
    const cfId = typeof d.cf_id === "string" ? d.cf_id.trim() : "";
    if (cfId && liveByCfId.has(cfId)) {
      existing = liveByCfId.get(cfId) ?? null;
    }
    if (!existing) {
      existing = liveByKey.get(key) ?? null;
    }

    if (!existing) {
      create.push({ key, desired: d });
    } else {
      matchedLiveKeys.add(existing.key);
      if (pageRulesNeedUpdate(normalized, existing.normalized)) {
        update.push({ key, desired: d, live: existing.live, cfId: existing.cfId });
      } else {
        unchanged.push(key);
      }
    }
  }

  if (prune) {
    for (const [key, item] of liveByKey) {
      if (!matchedLiveKeys.has(key)) {
        del.push({ key, live: item.live, cfId: item.cfId });
      }
    }
  }

  return {
    create,
    update,
    delete: del,
    unchanged,
    summary: {
      create: create.length,
      update: update.length,
      delete: del.length,
      unchanged: unchanged.length,
    },
  };
}

/**
 * @param {ReturnType<import('./cloudflare-api.mjs').createCloudflareClient>} api
 * @param {string} zoneId
 * @param {ReturnType<typeof planPageRuleSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyPageRuleSync(api, zoneId, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  /** @type {{ action: string; key: string; ok: boolean; error?: string }[]} */
  const results = [];

  for (const item of plan.create) {
    const label = item.desired.id || item.key.replace(/\|/g, " ");
    try {
      if (dryRun) {
        log(`dry-run: would create page rule ${label}`);
      } else {
        const body = normalizedToPageRuleBody(configPageRuleToNormalized(item.desired));
        await api.createPageRule(zoneId, body);
        log(`created page rule ${label}`);
      }
      results.push({ action: "create", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed create page rule ${label}: ${msg}`);
      results.push({ action: "create", key: item.key, ok: false, error: msg });
    }
  }

  for (const item of plan.update) {
    const label = item.desired.id || item.key.replace(/\|/g, " ");
    try {
      if (dryRun) {
        log(`dry-run: would update page rule ${label}`);
      } else {
        const body = normalizedToPageRuleBody(configPageRuleToNormalized(item.desired));
        await api.updatePageRule(zoneId, item.live.id, body);
        log(`updated page rule ${label}`);
      }
      results.push({ action: "update", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed update page rule ${label}: ${msg}`);
      results.push({ action: "update", key: item.key, ok: false, error: msg });
    }
  }

  for (const item of plan.delete) {
    const label = item.cfId || item.key.replace(/\|/g, " ");
    try {
      if (dryRun) {
        log(`dry-run: would delete page rule ${label}`);
      } else {
        await api.deletePageRule(zoneId, item.live.id);
        log(`deleted page rule ${label}`);
      }
      results.push({ action: "delete", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed delete page rule ${label}: ${msg}`);
      results.push({ action: "delete", key: item.key, ok: false, error: msg });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return { results, ok: failed.length === 0 };
}
