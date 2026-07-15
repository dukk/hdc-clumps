import {
  normalizeRecordData,
  normalizeRecordName,
  normalizeZoneName,
} from "../../../infrastructure/cloudflare/lib/cloudflare-config.mjs";
import { readResolvedPackageConfigJson } from "hdc/package/clump-run-config.mjs";
import { assertJsonObject, resolveRepoFile } from "hdc/cli/lib/private-repo.mjs";

const DEFAULT_CONFIG_PATH = "clumps/infrastructure/cloudflare/config.json";
const DEFAULT_EXCLUDE_TYPES = ["NS"];
const SUPPORTED_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "MX"]);

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @typedef {{ type: string; name: string; data: string; ttl: number }} BindDnsRecord
 */

/**
 * @typedef {object} CloudflareFallbackOpts
 * @property {string} [zone]
 * @property {string} [config_path]
 * @property {string[]} [exclude_types]
 */

/**
 * @param {Record<string, unknown>[]} records
 * @returns {BindDnsRecord[]}
 */
export function normalizeLocalBindRecords(records) {
  return records
    .filter(isObject)
    .map((rec) => ({
      type: String(rec.type ?? "").toUpperCase(),
      name: typeof rec.name === "string" ? rec.name.trim() : "",
      data: typeof rec.data === "string" ? rec.data.trim() : "",
      ttl: typeof rec.ttl === "number" && rec.ttl > 0 ? rec.ttl : 3600,
    }))
    .filter((r) => r.type && r.name && r.data);
}

/**
 * @param {BindDnsRecord} rec
 * @param {string} zoneId
 */
export function bindRecordKey(rec, zoneId) {
  const name = normalizeRecordName(rec.name, zoneId);
  const data = normalizeRecordData(rec.type, rec.data, undefined);
  return `${rec.type.toUpperCase()}|${name}|${data}`;
}

/**
 * @param {BindDnsRecord} rec
 * @param {string} zoneId
 */
function bindOwnerKey(rec, zoneId) {
  return normalizeRecordName(rec.name, zoneId);
}

/**
 * @param {BindDnsRecord[]} records
 * @param {string} zoneId
 * @returns {Map<string, Set<string>>}
 */
function ownerTypeMap(records, zoneId) {
  /** @type {Map<string, Set<string>>} */
  const map = new Map();
  for (const rec of records) {
    const owner = bindOwnerKey(rec, zoneId);
    const type = rec.type.toUpperCase();
    if (!map.has(owner)) map.set(owner, new Set());
    map.get(owner).add(type);
  }
  return map;
}

/**
 * @param {unknown} rec
 * @param {string} zoneName
 * @returns {BindDnsRecord | null}
 */
export function cloudflareRecordToBind(rec, zoneName) {
  if (!isObject(rec)) return null;
  const type = typeof rec.type === "string" ? rec.type.trim().toUpperCase() : "";
  if (!SUPPORTED_TYPES.has(type)) return null;
  const name = normalizeRecordName(
    typeof rec.name === "string" ? rec.name : "",
    zoneName,
  );
  const priority = typeof rec.priority === "number" ? rec.priority : undefined;
  const data = normalizeRecordData(
    type,
    typeof rec.data === "string" ? rec.data : "",
    priority,
  );
  if (!data) return null;
  const rawTtl = typeof rec.ttl === "number" ? rec.ttl : 3600;
  const ttl = rawTtl > 1 ? rawTtl : 3600;
  return { type, name, data, ttl };
}

/**
 * Master zone files always inject NS at @; skip Cloudflare apex types that cannot coexist.
 * @param {BindDnsRecord[]} records
 * @param {string} zoneId
 */
export function filterApexNsConflicts(records, zoneId) {
  const blockedAtApex = new Set(["A", "AAAA", "CNAME", "NS"]);
  return records.filter((rec) => {
    const owner = bindOwnerKey(rec, zoneId);
    if (owner !== "@") return true;
    return !blockedAtApex.has(rec.type.toUpperCase());
  });
}

/**
 * @param {string} repoRoot
 * @param {CloudflareFallbackOpts} fallback
 * @param {string} zoneId
 * @returns {BindDnsRecord[]}
 */
export function loadCloudflareFallbackRecords(repoRoot, fallback, zoneId) {
  const configPath =
    typeof fallback.config_path === "string" && fallback.config_path.trim()
      ? fallback.config_path.trim()
      : DEFAULT_CONFIG_PATH;
  const zoneName =
    typeof fallback.zone === "string" && fallback.zone.trim()
      ? fallback.zone.trim()
      : zoneId;
  const excludeTypes = new Set(
    (Array.isArray(fallback.exclude_types) ? fallback.exclude_types : DEFAULT_EXCLUDE_TYPES)
      .map((t) => String(t).trim().toUpperCase())
      .filter(Boolean),
  );

  const resolved = resolveRepoFile(repoRoot, configPath);
  if (!resolved.found) {
    throw new Error(
      `cloudflare_fallback for zone ${JSON.stringify(zoneId)}: config not found at ${JSON.stringify(configPath)}`,
    );
  }
  const cfg = assertJsonObject(readResolvedPackageConfigJson(resolved, { publicRoot: repoRoot }));
  const zones = Array.isArray(cfg.zones) ? cfg.zones : [];
  const target = normalizeZoneName(zoneName);
  const cfZone = zones.find(
    (z) => isObject(z) && normalizeZoneName(String(z.name ?? "")) === target,
  );
  if (!cfZone || !isObject(cfZone)) {
    throw new Error(
      `cloudflare_fallback for zone ${JSON.stringify(zoneId)}: Cloudflare zone ${JSON.stringify(zoneName)} not found in ${JSON.stringify(configPath)}`,
    );
  }
  const records = Array.isArray(cfZone.records) ? cfZone.records : [];
  /** @type {BindDnsRecord[]} */
  const out = [];
  for (const rec of records) {
    if (!isObject(rec)) continue;
    const type = typeof rec.type === "string" ? rec.type.trim().toUpperCase() : "";
    if (excludeTypes.has(type)) continue;
    const bindRec = cloudflareRecordToBind(rec, zoneName);
    if (bindRec) out.push(bindRec);
  }
  return filterApexNsConflicts(out, zoneName);
}

/**
 * Merge Cloudflare fallback records into local BIND records (local wins on conflict).
 * @param {BindDnsRecord[]} localRecords
 * @param {BindDnsRecord[]} cloudflareRecords
 * @param {string} zoneId
 */
export function mergeCloudflareFallbackRecords(localRecords, cloudflareRecords, zoneId) {
  const local = [...localRecords];
  const localKeys = new Set(local.map((r) => bindRecordKey(r, zoneId)));
  const localOwners = ownerTypeMap(local, zoneId);

  /** @type {BindDnsRecord[]} */
  const merged = [...local];

  for (const cf of cloudflareRecords) {
    const key = bindRecordKey(cf, zoneId);
    if (localKeys.has(key)) continue;

    const owner = bindOwnerKey(cf, zoneId);
    const localTypes = localOwners.get(owner);
    if (localTypes && localTypes.size > 0) continue;

    merged.push(cf);
    localKeys.add(key);
    if (!localOwners.has(owner)) localOwners.set(owner, new Set());
    localOwners.get(owner).add(cf.type.toUpperCase());
  }

  return merged.sort((a, b) => {
    const oa = bindOwnerKey(a, zoneId);
    const ob = bindOwnerKey(b, zoneId);
    if (oa !== ob) return oa.localeCompare(ob);
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.data.localeCompare(b.data);
  });
}

/**
 * @param {Record<string, unknown>} zone
 * @param {BindDnsRecord[]} localRecords
 * @param {string} zoneId
 * @param {string} repoRoot
 */
export function mergeZoneWithCloudflareFallback(zone, localRecords, zoneId, repoRoot) {
  const fallback = isObject(zone.cloudflare_fallback) ? zone.cloudflare_fallback : null;
  if (!fallback) return localRecords;
  const cfRecords = loadCloudflareFallbackRecords(repoRoot, fallback, zoneId);
  return mergeCloudflareFallbackRecords(localRecords, cfRecords, zoneId);
}
