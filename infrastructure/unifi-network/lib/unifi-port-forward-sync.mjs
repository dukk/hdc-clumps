import {
  configEntryToNormalized,
  liveRowToNormalized,
  portForwardMatchKey,
  portForwardsNeedUpdate,
  normalizedToApiBody,
} from "./unifi-config.mjs";
import { classicRestWrite, normalizeClassicSiteKey } from "./unifi-api.mjs";

/** @typedef {import('./unifi-config.mjs').ConfigPortForward} ConfigPortForward */
/** @typedef {import('./unifi-config.mjs').NormalizedPortForward} NormalizedPortForward */

/**
 * @param {Record<string, unknown>} liveRow
 * @returns {string}
 */
function liveUnifiId(liveRow) {
  return typeof liveRow._id === "string" ? liveRow._id.trim() : "";
}

/**
 * @param {ConfigPortForward[]} desired
 * @param {Record<string, unknown>[]} live
 * @param {boolean} [prune]
 */
export function planPortForwardSync(desired, live, prune = false) {
  /** @type {Map<string, { desired: ConfigPortForward; normalized: NormalizedPortForward; key: string }>} */
  const desiredMap = new Map();
  for (const d of desired) {
    const normalized = configEntryToNormalized(d);
    let key = portForwardMatchKey(normalized);
    const unifiId = typeof d.unifi_id === "string" ? d.unifi_id.trim() : "";
    if (unifiId) key = `${key}|${unifiId}`;
    if (desiredMap.has(key)) {
      throw new Error(`Duplicate desired port forward key in config: ${key.replace(/\|/g, " ")}`);
    }
    desiredMap.set(key, { desired: d, normalized, key });
  }

  /** @type {Map<string, { live: Record<string, unknown>; normalized: NormalizedPortForward; key: string; unifiId: string }>} */
  const liveByKey = new Map();
  /** @type {Map<string, { live: Record<string, unknown>; normalized: NormalizedPortForward; key: string; unifiId: string }>} */
  const liveByUnifiId = new Map();
  for (const l of live) {
    const normalized = liveRowToNormalized(l);
    let key = portForwardMatchKey(normalized);
    const unifiId = liveUnifiId(l);
    if (liveByKey.has(key)) {
      if (!unifiId) {
        throw new Error(`Duplicate live port forward key on controller: ${key.replace(/\|/g, " ")}`);
      }
      key = `${key}|${unifiId}`;
    }
    const item = { live: l, normalized, key, unifiId };
    liveByKey.set(key, item);
    if (unifiId) {
      if (liveByUnifiId.has(unifiId)) {
        throw new Error(`Duplicate live port forward _id on controller: ${unifiId}`);
      }
      liveByUnifiId.set(unifiId, item);
    }
  }

  /** @type {{ key: string; desired: ConfigPortForward }[]} */
  const create = [];
  /** @type {{ key: string; desired: ConfigPortForward; live: Record<string, unknown>; unifiId: string }[]} */
  const update = [];
  /** @type {{ key: string; live: Record<string, unknown>; unifiId: string }[]} */
  const del = [];
  /** @type {string[]} */
  const unchanged = [];

  /** @type {Set<string>} */
  const matchedLiveKeys = new Set();

  for (const [key, { desired: d, normalized }] of desiredMap) {
    let existing = null;
    const unifiId = typeof d.unifi_id === "string" ? d.unifi_id.trim() : "";
    if (unifiId && liveByUnifiId.has(unifiId)) {
      existing = liveByUnifiId.get(unifiId) ?? null;
    }
    if (!existing) {
      existing = liveByKey.get(key) ?? null;
    }

    if (!existing) {
      create.push({ key, desired: d });
    } else {
      matchedLiveKeys.add(existing.key);
      if (portForwardsNeedUpdate(normalized, existing.normalized)) {
        update.push({ key, desired: d, live: existing.live, unifiId: existing.unifiId });
      } else {
        unchanged.push(key);
      }
    }
  }

  if (prune) {
    for (const [key, item] of liveByKey) {
      if (!matchedLiveKeys.has(key)) {
        del.push({ key, live: item.live, unifiId: item.unifiId });
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
 * @param {object} ctx
 * @param {string} ctx.base
 * @param {string} ctx.apiKey
 * @param {string} ctx.siteId integration site id (not used for classic REST writes)
 * @param {string} [ctx.classicSiteKey] classic site key (e.g. default)
 * @param {boolean} ctx.rejectUnauthorized
 * @param {ReturnType<typeof planPortForwardSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyPortForwardSync(ctx, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});
  const classicSiteKey = normalizeClassicSiteKey(ctx.classicSiteKey || "default");

  /** @type {{ action: string; key: string; ok: boolean; error?: string }[]} */
  const results = [];

  /** Disable/update before create so superseded WAN ports are freed (e.g. old WAF → nginx-waf). */
  const updates = [...plan.update].sort((a, b) => {
    const aDisable = a.desired.enabled === false ? 0 : 1;
    const bDisable = b.desired.enabled === false ? 0 : 1;
    return aDisable - bDisable;
  });

  for (const item of updates) {
    const label = `${item.desired.id} (${item.key.replace(/\|/g, " ")})`;
    const rowId = item.unifiId || liveUnifiId(item.live);
    if (!rowId) {
      const msg = "missing live _id for update";
      log(`failed update ${label}: ${msg}`);
      results.push({ action: "update", key: item.key, ok: false, error: msg });
      continue;
    }
    try {
      if (dryRun) {
        log(`dry-run: would update ${label}${item.desired.enabled === false ? " (disable)" : ""}`);
      } else {
        const body = normalizedToApiBody(configEntryToNormalized(item.desired));
        await classicRestWrite(
          ctx.base,
          ctx.apiKey,
          classicSiteKey,
          "portforward",
          "PUT",
          body,
          rowId,
          ctx.rejectUnauthorized,
        );
        log(`updated ${label}${item.desired.enabled === false ? " (disabled)" : ""}`);
      }
      results.push({ action: "update", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed update ${label}: ${msg}`);
      results.push({ action: "update", key: item.key, ok: false, error: msg });
    }
  }

  for (const item of plan.create) {
    const label = `${item.desired.id} (${item.key.replace(/\|/g, " ")})`;
    try {
      if (dryRun) {
        log(`dry-run: would create ${label}`);
      } else {
        const body = normalizedToApiBody(configEntryToNormalized(item.desired));
        await classicRestWrite(
          ctx.base,
          ctx.apiKey,
          classicSiteKey,
          "portforward",
          "POST",
          body,
          null,
          ctx.rejectUnauthorized,
        );
        log(`created ${label}`);
      }
      results.push({ action: "create", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed create ${label}: ${msg}`);
      results.push({ action: "create", key: item.key, ok: false, error: msg });
    }
  }

  for (const item of plan.delete) {
    const label = item.key.replace(/\|/g, " ");
    const rowId = item.unifiId || liveUnifiId(item.live);
    if (!rowId) {
      const msg = "missing live _id for delete";
      log(`failed delete ${label}: ${msg}`);
      results.push({ action: "delete", key: item.key, ok: false, error: msg });
      continue;
    }
    try {
      if (dryRun) {
        log(`dry-run: would delete ${label}`);
      } else {
        await classicRestWrite(
          ctx.base,
          ctx.apiKey,
          classicSiteKey,
          "portforward",
          "DELETE",
          null,
          rowId,
          ctx.rejectUnauthorized,
        );
        log(`deleted ${label}`);
      }
      results.push({ action: "delete", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed delete ${label}: ${msg}`);
      results.push({ action: "delete", key: item.key, ok: false, error: msg });
    }
  }

  const ok = results.every((r) => r.ok);
  return { ok, results };
}

/**
 * @param {ConfigPortForward[]} desired
 * @param {Record<string, unknown>[]} live
 */
export function diffPortForwardSync(desired, live) {
  try {
    return planPortForwardSync(desired, live, false);
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
      create: [],
      update: [],
      delete: [],
      unchanged: [],
      summary: { create: 0, update: 0, delete: 0, unchanged: 0 },
    };
  }
}
