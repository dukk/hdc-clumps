import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import {
  livePageRuleToNormalized,
  normalizedPageRuleToConfigEntry,
  slugFromPageRuleTarget,
} from "./cloudflare-page-rules-config.mjs";
import {
  liveCatchAllToNormalized,
  liveEmailRoutingRuleToNormalized,
  normalizedCatchAllToConfigEntry,
  normalizedEmailRoutingRuleToConfigEntry,
  slugFromEmailRoutingMatcher,
} from "./cloudflare-email-routing-config.mjs";

/** @typedef {import('./cloudflare-config.mjs').NormalizedRecord} NormalizedRecord */

const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/cloudflare/config.example.json";

export const CLOUDFLARE_COMPACT_ARRAY_KEYS = ["records", "page_rules", "email_routing_rules"];

/**
 * @param {NormalizedRecord} rec
 * @returns {Record<string, unknown>}
 */
export function normalizedRecordToConfigEntry(rec) {
  /** @type {Record<string, unknown>} */
  const entry = {
    type: rec.type,
    name: rec.name,
    data: rec.data,
    ttl: rec.ttl,
  };
  if (["A", "AAAA", "CNAME"].includes(rec.type)) {
    entry.proxied = rec.proxied;
  }
  if (rec.type === "MX" && typeof rec.priority === "number") {
    entry.priority = rec.priority;
  }
  return entry;
}

/**
 * @param {NormalizedRecord[]} records
 */
function sortRecordsForConfig(records) {
  return [...records].sort((a, b) => {
    const tc = a.type.localeCompare(b.type);
    if (tc !== 0) return tc;
    return a.name.localeCompare(b.name);
  });
}

/**
 * @param {ReturnType<typeof livePageRuleToNormalized>[]} rules
 */
function sortPageRulesForConfig(rules) {
  return [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/**
 * @param {ReturnType<typeof liveEmailRoutingRuleToNormalized>[]} rules
 */
function sortEmailRoutingRulesForConfig(rules) {
  return [...rules].sort((a, b) => {
    const pa = typeof a.priority === "number" ? a.priority : 0;
    const pb = typeof b.priority === "number" ? b.priority : 0;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
}

/**
 * @param {import('./cloudflare-api.mjs').CfPageRule[]} liveRules
 * @param {Map<string, string>} [existingIdsByCfId]
 */
export function importPageRulesFromLive(liveRules, existingIdsByCfId = new Map()) {
  /** @type {Record<string, unknown>[]} */
  const usedIds = new Set();
  return sortPageRulesForConfig(
    liveRules.map((live) => {
      const normalized = livePageRuleToNormalized(live);
      let id = live.id && existingIdsByCfId.has(live.id) ? existingIdsByCfId.get(live.id) : "";
      if (!id) {
        id = slugFromPageRuleTarget(normalized.target);
        let candidate = id;
        let n = 2;
        while (usedIds.has(candidate)) {
          candidate = `${id}-${n}`;
          n += 1;
        }
        id = candidate;
      }
      usedIds.add(id);
      normalized.id = id;
      return normalized;
    })
  ).map((r) => normalizedPageRuleToConfigEntry(r));
}

/**
 * @param {import('./cloudflare-api.mjs').CfEmailRoutingRule[]} liveRules
 * @param {Map<string, string>} [existingIdsByCfId]
 */
export function importEmailRoutingRulesFromLive(liveRules, existingIdsByCfId = new Map()) {
  /** @type {Set<string>} */
  const usedIds = new Set();
  return sortEmailRoutingRulesForConfig(
    liveRules.map((live) => {
      const normalized = liveEmailRoutingRuleToNormalized(live);
      let id = live.id && existingIdsByCfId.has(live.id) ? existingIdsByCfId.get(live.id) : "";
      if (!id) {
        const matcher = normalized.matchers[0];
        id = matcher ? slugFromEmailRoutingMatcher(matcher) : "email-rule";
        let candidate = id;
        let n = 2;
        while (usedIds.has(candidate)) {
          candidate = `${id}-${n}`;
          n += 1;
        }
        id = candidate;
      }
      usedIds.add(id);
      normalized.id = id;
      return normalized;
    })
  ).map((r) => normalizedEmailRoutingRuleToConfigEntry(r));
}

/**
 * @param {import('./cloudflare-api.mjs').CfEmailRoutingCatchAll | null} liveCatchAll
 */
export function importCatchAllFromLive(liveCatchAll) {
  const normalized = liveCatchAllToNormalized(liveCatchAll);
  if (!normalized) return undefined;
  return normalizedCatchAllToConfigEntry(normalized);
}

/**
 * @param {{ name: string; records: NormalizedRecord[] }[]} liveZones
 * @returns {{ name: string; records: Record<string, unknown>[] }[]}
 */
export function importZonesFromLive(liveZones) {
  return liveZones
    .map((z) => ({
      name: z.name,
      records: sortRecordsForConfig(z.records).map((r) => normalizedRecordToConfigEntry(r)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build cf_id → config id map from existing zone config entry.
 * @param {Record<string, unknown>[]} rules
 */
function existingIdsFromConfigRules(rules) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const r of rules) {
    if (typeof r !== "object" || r === null) continue;
    const row = /** @type {{ id?: string; cf_id?: string }} */ (r);
    const cfId = typeof row.cf_id === "string" ? row.cf_id.trim() : "";
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (cfId && id) map.set(cfId, id);
  }
  return map;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {{ name: string; records: NormalizedRecord[] }[]} opts.liveZones
 * @param {(line: string) => void} [opts.log]
 */
export function importZonesToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  const zones = importZonesFromLive(opts.liveZones);
  const recordCount = zones.reduce((n, z) => n + z.records.length, 0);
  const next = { ...cfgRaw, zones };
  writeResolvedRepoJson(resolved, next, { compactArrayKeys: CLOUDFLARE_COMPACT_ARRAY_KEYS });
  log(`Wrote ${zones.length} zone(s), ${recordCount} record(s) to config (${source}: ${resolved.rel}).`);
  return { zones, recordCount, configPath: resolved.path, configRel: resolved.rel, source };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {{ name: string; page_rules: import('./cloudflare-api.mjs').CfPageRule[] }[]} opts.liveByZone
 * @param {(line: string) => void} [opts.log]
 */
export function importPageRulesToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  const liveByName = new Map(opts.liveByZone.map((z) => [z.name, z.page_rules]));
  const zonesRaw = Array.isArray(cfgRaw.zones) ? cfgRaw.zones : [];
  let updated = 0;
  const nextZones = zonesRaw.map((z) => {
    if (typeof z !== "object" || z === null) return z;
    const row = /** @type {Record<string, unknown>} */ ({ ...z });
    const name = typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
    if (!name || !liveByName.has(name)) return row;
    const liveRules = liveByName.get(name) ?? [];
    const existingRules = Array.isArray(row.page_rules) ? row.page_rules : [];
    row.page_rules = importPageRulesFromLive(liveRules, existingIdsFromConfigRules(existingRules));
    updated += 1;
    return row;
  });
  const next = { ...cfgRaw, zones: nextZones };
  writeResolvedRepoJson(resolved, next, { compactArrayKeys: CLOUDFLARE_COMPACT_ARRAY_KEYS });
  log(`Updated page_rules on ${updated} zone(s) in config (${source}: ${resolved.rel}).`);
  return { zones_updated: updated, configRel: resolved.rel, source };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {{ name: string; email_routing_rules: import('./cloudflare-api.mjs').CfEmailRoutingRule[]; catch_all: import('./cloudflare-api.mjs').CfEmailRoutingCatchAll | null }[]} opts.liveByZone
 * @param {(line: string) => void} [opts.log]
 */
export function importEmailRoutingToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  const liveByName = new Map(opts.liveByZone.map((z) => [z.name, z]));
  const zonesRaw = Array.isArray(cfgRaw.zones) ? cfgRaw.zones : [];
  let updated = 0;
  const nextZones = zonesRaw.map((z) => {
    if (typeof z !== "object" || z === null) return z;
    const row = /** @type {Record<string, unknown>} */ ({ ...z });
    const name = typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
    const live = liveByName.get(name);
    if (!name || !live) return row;
    const existingRules = Array.isArray(row.email_routing_rules) ? row.email_routing_rules : [];
    row.email_routing_rules = importEmailRoutingRulesFromLive(
      live.email_routing_rules,
      existingIdsFromConfigRules(existingRules)
    );
    const catchAll = importCatchAllFromLive(live.catch_all);
    if (catchAll) {
      row.email_routing = { ...(isObject(row.email_routing) ? row.email_routing : {}), catch_all: catchAll };
    } else if (isObject(row.email_routing)) {
      const er = /** @type {Record<string, unknown>} */ ({ ...row.email_routing });
      delete er.catch_all;
      row.email_routing = Object.keys(er).length ? er : undefined;
    }
    updated += 1;
    return row;
  });
  const next = { ...cfgRaw, zones: nextZones };
  writeResolvedRepoJson(resolved, next, { compactArrayKeys: CLOUDFLARE_COMPACT_ARRAY_KEYS });
  log(`Updated email routing on ${updated} zone(s) in config (${source}: ${resolved.rel}).`);
  return { zones_updated: updated, configRel: resolved.rel, source };
}

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
