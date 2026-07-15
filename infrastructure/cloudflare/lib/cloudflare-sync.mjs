import {
  liveRecordToNormalized,
  normalizedToApiBody,
  recordMatchKey,
  recordsNeedUpdate,
} from "./cloudflare-config.mjs";

/**
 * @typedef {import('./cloudflare-config.mjs').NormalizedRecord} NormalizedRecord
 * @typedef {import('./cloudflare-api.mjs').CfDnsRecord} CfDnsRecord
 */

/**
 * @param {object} opts
 * @param {NormalizedRecord[]} opts.desired
 * @param {CfDnsRecord[]} opts.live
 * @param {string} opts.zoneName
 * @param {boolean} [opts.prune]
 */
export function planZoneSync(opts) {
  const { desired, live, zoneName, prune = false } = opts;

  /** @type {Map<string, { desired: NormalizedRecord; key: string }>} */
  const desiredMap = new Map();
  for (const d of desired) {
    const key = recordMatchKey(d, zoneName);
    if (desiredMap.has(key)) {
      throw new Error(`Duplicate desired record key in config: ${key.replace(/\|/g, " ")}`);
    }
    desiredMap.set(key, { desired: d, key });
  }

  /** @type {Map<string, { live: CfDnsRecord; normalized: NormalizedRecord }>} */
  const liveMap = new Map();
  for (const l of live) {
    const normalized = liveRecordToNormalized(l, zoneName);
    const key = recordMatchKey(normalized, zoneName);
    if (liveMap.has(key)) {
      throw new Error(`Duplicate live record key in Cloudflare: ${key.replace(/\|/g, " ")}`);
    }
    liveMap.set(key, { live: l, normalized });
  }

  /** @type {{ key: string; desired: NormalizedRecord }[]} */
  const create = [];
  /** @type {{ key: string; desired: NormalizedRecord; live: CfDnsRecord }[]} */
  const update = [];
  /** @type {{ key: string; live: CfDnsRecord }[]} */
  const del = [];
  /** @type {string[]} */
  const unchanged = [];

  for (const [key, { desired: d }] of desiredMap) {
    const existing = liveMap.get(key);
    if (!existing) {
      create.push({ key, desired: d });
    } else if (recordsNeedUpdate(d, existing.normalized)) {
      update.push({ key, desired: d, live: existing.live });
    } else {
      unchanged.push(key);
    }
  }

  if (prune) {
    for (const [key, { live: l }] of liveMap) {
      if (!desiredMap.has(key)) del.push({ key, live: l });
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
 * @param {string} zoneName
 * @param {ReturnType<typeof planZoneSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyZoneSync(api, zoneId, zoneName, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  /** @type {{ action: string; key: string; ok: boolean; error?: string }[]} */
  const results = [];

  for (const item of plan.create) {
    const label = item.key.replace(/\|/g, " ");
    try {
      if (dryRun) {
        log(`dry-run: would create ${label}`);
      } else {
        const body = normalizedToApiBody(item.desired, zoneName);
        await api.createDnsRecord(zoneId, body);
        log(`created ${label}`);
      }
      results.push({ action: "create", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed create ${label}: ${msg}`);
      results.push({ action: "create", key: item.key, ok: false, error: msg });
    }
  }

  for (const item of plan.update) {
    const label = item.key.replace(/\|/g, " ");
    try {
      if (dryRun) {
        log(`dry-run: would update ${label}`);
      } else {
        const body = normalizedToApiBody(item.desired, zoneName);
        await api.updateDnsRecord(zoneId, item.live.id, body);
        log(`updated ${label}`);
      }
      results.push({ action: "update", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed update ${label}: ${msg}`);
      results.push({ action: "update", key: item.key, ok: false, error: msg });
    }
  }

  for (const item of plan.delete) {
    const label = item.key.replace(/\|/g, " ");
    try {
      if (dryRun) {
        log(`dry-run: would delete ${label}`);
      } else {
        await api.deleteDnsRecord(zoneId, item.live.id);
        log(`deleted ${label}`);
      }
      results.push({ action: "delete", key: item.key, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed delete ${label}: ${msg}`);
      results.push({ action: "delete", key: item.key, ok: false, error: msg });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return { results, ok: failed.length === 0 };
}
