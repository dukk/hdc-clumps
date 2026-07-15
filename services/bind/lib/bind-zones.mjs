import {
  mergeZoneWithCloudflareFallback,
  normalizeLocalBindRecords,
} from "./bind-cloudflare-fallback.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse IPv4 CIDR; returns [networkInt, prefixLen] or null.
 * @param {string} cidr
 */
export function parseIpv4Cidr(cidr) {
  const m = String(cidr).trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  const parts = m[1].split(".").map((x) => Number(x));
  if (parts.some((n) => n < 0 || n > 255)) return null;
  const prefix = Number(m[2]);
  if (prefix < 0 || prefix > 32) return null;
  const ip =
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { network: ip & mask, prefix, mask };
}

/**
 * @param {string} ip
 */
export function ipv4ToInt(ip) {
  const parts = ip.trim().split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => n < 0 || n > 255)) return null;
  return (
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0)
  );
}

/**
 * PTR owner name under in-addr.arpa for an IPv4 address (e.g. 2.0.0 for 192.0.2.2).
 * @param {string} ip
 */
export function ptrOwnerForIp(ip) {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  return `${parts[3]}.${parts[2]}.${parts[1]}`;
}

/**
 * SOA serial from wall-clock UTC: YYYYMMDD + 2-digit revision (≤ 2147483647 for BIND).
 * Revision is minutes-since-midnight mod 100 so multiple updates per day stay valid.
 * @param {Date} [date]
 */
export function soaSerialFromTimestamp(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const rev = (date.getUTCHours() * 60 + date.getUTCMinutes()) % 100;
  return `${y}${m}${d}${String(rev).padStart(2, "0")}`;
}

/**
 * Collect A records from forward zones for PTR synthesis.
 * @param {Record<string, Record<string, unknown>>} zones
 */
export function collectForwardARecords(zones) {
  /** @type {{ zone: string; name: string; fqdn: string; ip: string; ttl: number }[]} */
  const out = [];
  for (const [zoneName, zone] of Object.entries(zones)) {
    if (zone.zone_type !== "forward") continue;
    const records = Array.isArray(zone.records) ? zone.records : [];
    for (const rec of records) {
      if (!isObject(rec) || rec.type !== "A") continue;
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      const data = typeof rec.data === "string" ? rec.data.trim() : "";
      if (!data) continue;
      const ttl = typeof rec.ttl === "number" && rec.ttl > 0 ? rec.ttl : 3600;
      const label = name === "@" || name === "" ? zoneName : `${name}.${zoneName}`;
      const fqdn = label.endsWith(".") ? label : `${label}.`;
      out.push({ zone: zoneName, name, fqdn, ip: data, ttl });
    }
  }
  return out;
}

/**
 * Build merged record list for a reverse zone (explicit + auto PTR from forward A).
 * @param {Record<string, unknown>} reverseZone
 * @param {{ zone: string; name: string; fqdn: string; ip: string; ttl: number }[]} forwardAs
 */
export function mergeReverseRecords(reverseZone, forwardAs) {
  const subnet = typeof reverseZone.subnet === "string" ? reverseZone.subnet.trim() : "";
  const parsed = subnet ? parseIpv4Cidr(subnet) : null;
  /** @type {{ type: string; name: string; data: string; ttl: number }[]} */
  const explicit = [];
  const records = Array.isArray(reverseZone.records) ? reverseZone.records : [];
  for (const rec of records) {
    if (!isObject(rec)) continue;
    const type = typeof rec.type === "string" ? rec.type : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const data = typeof rec.data === "string" ? rec.data.trim() : "";
    const ttl = typeof rec.ttl === "number" && rec.ttl > 0 ? rec.ttl : 3600;
    if (type && name && data) explicit.push({ type, name, data, ttl });
  }

  /** @type {Map<string, { type: string; name: string; data: string; ttl: number }>} */
  const auto = new Map();
  if (parsed) {
    for (const a of forwardAs) {
      const ipInt = ipv4ToInt(a.ip);
      if (ipInt === null) continue;
      if ((ipInt & parsed.mask) !== parsed.network) continue;
      const owner = ptrOwnerForIp(a.ip);
      if (!owner) continue;
      const ptrTarget = a.fqdn.endsWith(".") ? a.fqdn : `${a.fqdn}.`;
      auto.set(owner, { type: "PTR", name: owner, data: ptrTarget, ttl: a.ttl });
    }
  }

  /** @type {Map<string, { type: string; name: string; data: string; ttl: number }>} */
  const merged = new Map(auto);
  for (const r of explicit) {
    merged.set(r.name, r);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reject invalid owner combinations (e.g. CNAME plus A at the same name).
 * @param {{ type: string; name: string; data: string; ttl: number }[]} records
 * @param {string} zoneId
 */
export function validateZoneRecords(records, zoneId) {
  /** @type {Map<string, Set<string>>} */
  const byOwner = new Map();
  for (const rec of records) {
    const owner = rec.name === "@" || rec.name === "" ? "@" : rec.name;
    const type = rec.type.toUpperCase();
    if (!byOwner.has(owner)) byOwner.set(owner, new Set());
    byOwner.get(owner).add(type);
  }
  /** @type {string[]} */
  const errors = [];
  for (const [owner, types] of byOwner) {
    if (!types.has("CNAME")) continue;
    if (types.size === 1) continue;
    const label = owner === "@" ? zoneId : `${owner}.${zoneId}`;
    errors.push(
      `${label}: CNAME cannot coexist with ${[...types].filter((t) => t !== "CNAME").join(", ")}`,
    );
  }
  if (errors.length) {
    throw new Error(`zone ${JSON.stringify(zoneId)}: ${errors.join("; ")}`);
  }
}

/**
 * @param {string[]} zoneIds
 * @param {Record<string, Record<string, unknown>>} zoneMap
 * @param {{ primaryNs: string; secondaryNs: string; primaryIp: string; secondaryIp: string; hostmaster: string }} ns
 * @param {{ serial: string; repoRoot?: string }} opts
 */
export function buildZoneBundle(zoneIds, zoneMap, ns, opts) {
  const repoRoot = typeof opts.repoRoot === "string" && opts.repoRoot.trim() ? opts.repoRoot.trim() : "";
  const forwardAs = collectForwardARecords(zoneMap);
  /** @type {{ id: string; zoneType: string; records: { type: string; name: string; data: string; ttl: number }[]; serial: string }[]} */
  const bundles = [];

  for (const id of zoneIds) {
    const zone = zoneMap[id];
    if (!zone) {
      throw new Error(`zone ${JSON.stringify(id)} not found in bind config zones[]`);
    }
    const zoneType = zone.zone_type === "reverse" ? "reverse" : "forward";
    let records;
    if (zoneType === "reverse") {
      records = mergeReverseRecords(zone, forwardAs);
    } else {
      const localRecords = normalizeLocalBindRecords(
        Array.isArray(zone.records) ? zone.records : [],
      );
      records =
        isObject(zone.cloudflare_fallback) && repoRoot
          ? mergeZoneWithCloudflareFallback(zone, localRecords, id, repoRoot)
          : localRecords;
    }
    validateZoneRecords(records, id);
    bundles.push({ id, zoneType, records, serial: opts.serial });
  }

  return { bundles, ns };
}
