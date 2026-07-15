import {
  catchAllNeedUpdate,
  configEmailRoutingRuleToNormalized,
  configEntryToCatchAll,
  liveCatchAllToNormalized,
  liveEmailRoutingRuleToNormalized,
  normalizedToCatchAllBody,
  normalizedToEmailRoutingRuleBody,
  emailRoutingRuleMatchKey,
  emailRoutingRulesNeedUpdate,
} from "./cloudflare-email-routing-config.mjs";

/** @typedef {import('./cloudflare-email-routing-config.mjs').ConfigEmailRoutingRule} ConfigEmailRoutingRule */
/** @typedef {import('./cloudflare-email-routing-config.mjs').ConfigEmailRoutingCatchAll} ConfigEmailRoutingCatchAll */
/** @typedef {import('./cloudflare-api.mjs').CfEmailRoutingRule} CfEmailRoutingRule */
/** @typedef {import('./cloudflare-api.mjs').CfEmailRoutingCatchAll} CfEmailRoutingCatchAll */

/**
 * @param {ConfigEmailRoutingRule[]} desired
 * @param {CfEmailRoutingRule[]} live
 * @param {boolean} [prune]
 */
export function planEmailRoutingRuleSync(desired, live, prune = false) {
  /** @type {Map<string, { desired: ConfigEmailRoutingRule; key: string }>} */
  const desiredMap = new Map();
  for (const d of desired) {
    const normalized = configEmailRoutingRuleToNormalized(d);
    let key = emailRoutingRuleMatchKey(normalized);
    const cfId = typeof d.cf_id === "string" ? d.cf_id.trim() : "";
    if (cfId) key = `${key}|${cfId}`;
    if (desiredMap.has(key)) {
      throw new Error(`Duplicate desired email routing rule key in config: ${key.replace(/\|/g, " ")}`);
    }
    desiredMap.set(key, { desired: d, key });
  }

  /** @type {Map<string, { live: CfEmailRoutingRule; normalized: ReturnType<typeof liveEmailRoutingRuleToNormalized>; key: string; cfId: string }>} */
  const liveByKey = new Map();
  /** @type {Map<string, { live: CfEmailRoutingRule; normalized: ReturnType<typeof liveEmailRoutingRuleToNormalized>; key: string; cfId: string }>} */
  const liveByCfId = new Map();
  for (const l of live) {
    const normalized = liveEmailRoutingRuleToNormalized(l);
    let key = emailRoutingRuleMatchKey(normalized);
    const cfId = l.id;
    if (liveByKey.has(key)) {
      if (!cfId) {
        throw new Error(`Duplicate live email routing rule key in Cloudflare: ${key.replace(/\|/g, " ")}`);
      }
      key = `${key}|${cfId}`;
    }
    const item = { live: l, normalized, key, cfId };
    liveByKey.set(key, item);
    if (cfId) {
      if (liveByCfId.has(cfId)) {
        throw new Error(`Duplicate live email routing rule id in Cloudflare: ${cfId}`);
      }
      liveByCfId.set(cfId, item);
    }
  }

  /** @type {{ key: string; desired: ConfigEmailRoutingRule }[]} */
  const create = [];
  /** @type {{ key: string; desired: ConfigEmailRoutingRule; live: CfEmailRoutingRule; cfId: string }[]} */
  const update = [];
  /** @type {{ key: string; live: CfEmailRoutingRule; cfId: string }[]} */
  const del = [];
  /** @type {string[]} */
  const unchanged = [];

  /** @type {Set<string>} */
  const matchedLiveKeys = new Set();

  for (const [key, { desired: d }] of desiredMap) {
    const normalized = configEmailRoutingRuleToNormalized(d);
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
      if (emailRoutingRulesNeedUpdate(normalized, existing.normalized)) {
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
 * @param {ReturnType<typeof planEmailRoutingRuleSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyEmailRoutingRuleSync(api, zoneId, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  /** @type {{ action: string; key: string; ok: boolean; error?: string }[]} */
  const results = [];

  for (const item of plan.create) {
    const label = item.desired.id || item.key.replace(/\|/g, " ");
    try {
      if (dryRun) {
        log(`dry-run: would create email routing rule ${label}`);
      } else {
        const body = normalizedToEmailRoutingRuleBody(configEmailRoutingRuleToNormalized(item.desired));
        await api.createEmailRoutingRule(zoneId, body);
        log(`created email routing rule ${label}`);
      }
      results.push({ action: "create", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed create email routing rule ${label}: ${msg}`);
      results.push({ action: "create", key: item.key, ok: false, error: msg });
    }
  }

  for (const item of plan.update) {
    const label = item.desired.id || item.key.replace(/\|/g, " ");
    try {
      if (dryRun) {
        log(`dry-run: would update email routing rule ${label}`);
      } else {
        const body = normalizedToEmailRoutingRuleBody(configEmailRoutingRuleToNormalized(item.desired));
        await api.updateEmailRoutingRule(zoneId, item.live.id, body);
        log(`updated email routing rule ${label}`);
      }
      results.push({ action: "update", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed update email routing rule ${label}: ${msg}`);
      results.push({ action: "update", key: item.key, ok: false, error: msg });
    }
  }

  for (const item of plan.delete) {
    const label = item.cfId || item.key.replace(/\|/g, " ");
    try {
      if (dryRun) {
        log(`dry-run: would delete email routing rule ${label}`);
      } else {
        await api.deleteEmailRoutingRule(zoneId, item.live.id);
        log(`deleted email routing rule ${label}`);
      }
      results.push({ action: "delete", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed delete email routing rule ${label}: ${msg}`);
      results.push({ action: "delete", key: item.key, ok: false, error: msg });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return { results, ok: failed.length === 0 };
}

/**
 * @param {ConfigEmailRoutingCatchAll | null | undefined} desired
 * @param {CfEmailRoutingCatchAll | null} live
 */
export function planCatchAllSync(desired, live) {
  const desiredNorm = desired ? configEntryToCatchAll(desired) : null;
  const liveNorm = liveCatchAllToNormalized(live);

  if (!desiredNorm) {
    return { update: false, unchanged: true, summary: { update: 0, unchanged: 1 } };
  }
  if (!liveNorm) {
    return {
      update: true,
      unchanged: false,
      desired: desiredNorm,
      summary: { update: 1, unchanged: 0 },
    };
  }
  if (catchAllNeedUpdate(
    { enabled: desiredNorm.enabled, actions: desiredNorm.actions },
    liveNorm
  )) {
    return {
      update: true,
      unchanged: false,
      desired: desiredNorm,
      summary: { update: 1, unchanged: 0 },
    };
  }
  return { update: false, unchanged: true, summary: { update: 0, unchanged: 1 } };
}

/**
 * @param {ReturnType<import('./cloudflare-api.mjs').createCloudflareClient>} api
 * @param {string} zoneId
 * @param {ReturnType<typeof planCatchAllSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyCatchAllSync(api, zoneId, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (!plan.update) {
    return { ok: true, results: [] };
  }

  const body = normalizedToCatchAllBody(
    /** @type {import('./cloudflare-email-routing-config.mjs').NormalizedEmailRoutingCatchAll} */ (
      plan.desired
    )
  );

  try {
    if (dryRun) {
      log("dry-run: would update email routing catch-all");
    } else {
      await api.updateEmailRoutingCatchAll(zoneId, body);
      log("updated email routing catch-all");
    }
    return { ok: true, results: [{ action: "update", key: "catch_all", ok: true }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`failed update email routing catch-all: ${msg}`);
    return {
      ok: false,
      results: [{ action: "update", key: "catch_all", ok: false, error: msg }],
    };
  }
}
