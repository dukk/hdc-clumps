import { automatedInventoryIdFromName } from "hdc/package/automated-ids.mjs";
import { baseUrlFromString } from "./unifi-api.mjs";

/** @typedef {import('./unifi-config.mjs').ConfigPortForward} ConfigPortForward */
/** @typedef {import('./unifi-config.mjs').NormalizedPortForward} NormalizedPortForward */

/**
 * @typedef {object} ConfigPortForward
 * @property {string} id
 * @property {boolean} [managed]
 * @property {string} name
 * @property {boolean} [enabled]
 * @property {string} [pfwd_interface]
 * @property {string} [destination_ip]
 * @property {string} proto
 * @property {string} dst_port
 * @property {string} fwd
 * @property {string} [fwd_port]
 * @property {boolean} [log]
 * @property {string} [src]
 * @property {string} [src_port]
 * @property {string} [src_firewall_group_id]
 * @property {string} [dst_firewall_group_id]
 * @property {string} [unifi_id]
 */

/**
 * @typedef {object} NormalizedPortForward
 * @property {string} name
 * @property {boolean} enabled
 * @property {string} pfwd_interface
 * @property {string} destination_ip
 * @property {string} proto
 * @property {string} dst_port
 * @property {string} fwd
 * @property {string} fwd_port
 * @property {boolean} log
 * @property {string} src
 * @property {string} [src_port]
 * @property {string} [src_firewall_group_id]
 * @property {string} [dst_firewall_group_id]
 */

export const PORT_FORWARD_EXPORT_KEYS = new Set([
  "_id",
  "name",
  "enabled",
  "rule_index",
  "pfwd_interface",
  "destination_ip",
  "proto",
  "dst_port",
  "fwd",
  "fwd_port",
  "log",
  "src",
  "src_port",
  "src_firewall_group_id",
  "dst_firewall_group_id",
]);

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} v
 */
function strField(v) {
  return typeof v === "string" ? v.trim() : v !== undefined && v !== null ? String(v).trim() : "";
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function controllerFromPackageConfig(cfg) {
  const u = typeof cfg.controller_base_url === "string" ? cfg.controller_base_url.trim() : "";
  if (!u) return null;
  return {
    url: baseUrlFromString(u),
    provenance: "clumps/infrastructure/unifi-network/config.json (controller_base_url)",
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Set<string>} keys
 */
export function pickFields(row, keys) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of keys) {
    if (row[k] !== undefined) out[k] = row[k];
  }
  return out;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} collectedAt
 */
export function inventoryPortForwardEntry(row, collectedAt) {
  return { ...pickFields(row, PORT_FORWARD_EXPORT_KEYS), collected_at: collectedAt };
}

/**
 * @param {NormalizedPortForward} rec
 */
/**
 * Extract a WAN suffix token from rule names like "NGINX-WAF-A HTTP (.234)" → ".234".
 * @param {string} name
 */
export function wanSuffixFromPortForwardName(name) {
  const m = strField(name).match(/\(\.(\d+)/);
  return m ? `.${m[1]}` : "";
}

/**
 * Resolve UniFi `destination_ip` (public WAN bind address) for a config entry.
 * @param {Pick<ConfigPortForward, "name" | "destination_ip">} entry
 * @param {Record<string, string>} [wanIps] map ".234" / "234" → public IPv4
 */
export function resolveDestinationIp(entry, wanIps = {}) {
  const explicit = strField(entry.destination_ip);
  if (explicit) return explicit.toLowerCase() === "any" ? "any" : explicit;

  const suffix = wanSuffixFromPortForwardName(entry.name);
  if (suffix) {
    const bare = suffix.slice(1);
    for (const key of [suffix, bare]) {
      const ip = strField(wanIps[key]);
      if (ip) return ip;
    }
  }

  return "any";
}

export function portForwardMatchKey(rec) {
  const name = strField(rec.name).toLowerCase();
  const proto = strField(rec.proto).toLowerCase();
  const dst = strField(rec.dst_port);
  const fwd = strField(rec.fwd);
  const fwdPort = strField(rec.fwd_port);
  const destinationIp = strField(rec.destination_ip) || "any";
  return `${name}|${proto}|${dst}|${destinationIp}|${fwd}|${fwdPort}`;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {NormalizedPortForward}
 */
export function liveRowToNormalized(row) {
  return {
    name: strField(row.name) || "(unnamed)",
    enabled: row.enabled !== false,
    pfwd_interface: strField(row.pfwd_interface) || "WAN",
    destination_ip: strField(row.destination_ip) || "any",
    proto: strField(row.proto) || "tcp_udp",
    dst_port: strField(row.dst_port),
    fwd: strField(row.fwd),
    fwd_port: strField(row.fwd_port),
    log: row.log === true,
    src: strField(row.src) || "any",
    src_port: strField(row.src_port) || undefined,
    src_firewall_group_id: strField(row.src_firewall_group_id) || undefined,
    dst_firewall_group_id: strField(row.dst_firewall_group_id) || undefined,
  };
}

/**
 * @param {ConfigPortForward} entry
 * @returns {NormalizedPortForward}
 */
export function configEntryToNormalized(entry) {
  return {
    name: strField(entry.name) || "(unnamed)",
    enabled: entry.enabled !== false,
    pfwd_interface: strField(entry.pfwd_interface) || "WAN",
    destination_ip: resolveDestinationIp(entry),
    proto: strField(entry.proto) || "tcp_udp",
    dst_port: strField(entry.dst_port),
    fwd: strField(entry.fwd),
    fwd_port: strField(entry.fwd_port),
    log: entry.log === true,
    src: strField(entry.src) || "any",
    src_port: strField(entry.src_port) || undefined,
    src_firewall_group_id: strField(entry.src_firewall_group_id) || undefined,
    dst_firewall_group_id: strField(entry.dst_firewall_group_id) || undefined,
  };
}

/**
 * @param {NormalizedPortForward} desired
 * @param {NormalizedPortForward} live
 */
export function portForwardsNeedUpdate(desired, live) {
  const caseInsensitive = new Set(["name", "pfwd_interface", "proto", "src"]);
  const fields = /** @type {(keyof NormalizedPortForward)[]} */ ([
    "name",
    "enabled",
    "pfwd_interface",
    "destination_ip",
    "proto",
    "dst_port",
    "fwd",
    "fwd_port",
    "log",
    "src",
    "src_port",
    "src_firewall_group_id",
    "dst_firewall_group_id",
  ]);
  for (const f of fields) {
    const d = desired[f] ?? "";
    const l = live[f] ?? "";
    if (f === "enabled" || f === "log") {
      if (Boolean(d) !== Boolean(l)) return true;
      continue;
    }
    const ds = String(d);
    const ls = String(l);
    if (caseInsensitive.has(f)) {
      if (ds.toLowerCase() !== ls.toLowerCase()) return true;
      continue;
    }
    if (ds !== ls) return true;
  }
  return false;
}

/**
 * @param {NormalizedPortForward} normalized
 * @returns {Record<string, unknown>}
 */
export function normalizedToApiBody(normalized) {
  /** @type {Record<string, unknown>} */
  const body = {
    name: normalized.name,
    enabled: normalized.enabled,
    pfwd_interface: normalized.pfwd_interface,
    destination_ip: normalized.destination_ip || "any",
    proto: normalized.proto,
    dst_port: normalized.dst_port,
    fwd: normalized.fwd,
    fwd_port: normalized.fwd_port || normalized.dst_port,
    log: normalized.log,
    src: normalized.src,
  };
  if (normalized.src_port) body.src_port = normalized.src_port;
  if (normalized.src_firewall_group_id) body.src_firewall_group_id = normalized.src_firewall_group_id;
  if (normalized.dst_firewall_group_id) body.dst_firewall_group_id = normalized.dst_firewall_group_id;
  return body;
}

/**
 * @param {ConfigPortForward} entry
 */
export function configEntryToApiBody(entry) {
  return normalizedToApiBody(configEntryToNormalized(entry));
}

/**
 * @param {Record<string, unknown>} row
 * @param {Set<string>} usedIds
 * @returns {ConfigPortForward}
 */
export function liveRowToConfigEntry(row, usedIds) {
  const normalized = liveRowToNormalized(row);
  const id = automatedInventoryIdFromName("pf", row, usedIds);
  const unifiId = typeof row._id === "string" ? row._id.trim() : "";
  /** @type {ConfigPortForward} */
  const entry = {
    id,
    managed: true,
    name: normalized.name,
    enabled: normalized.enabled,
    pfwd_interface: normalized.pfwd_interface,
    destination_ip: normalized.destination_ip,
    proto: normalized.proto,
    dst_port: normalized.dst_port,
    fwd: normalized.fwd,
    fwd_port: normalized.fwd_port,
    log: normalized.log,
    src: normalized.src,
  };
  if (normalized.src_port) entry.src_port = normalized.src_port;
  if (normalized.src_firewall_group_id) entry.src_firewall_group_id = normalized.src_firewall_group_id;
  if (normalized.dst_firewall_group_id) entry.dst_firewall_group_id = normalized.dst_firewall_group_id;
  if (unifiId) entry.unifi_id = unifiId;
  return entry;
}

/**
 * @param {Record<string, unknown>[]} liveRows
 * @returns {ConfigPortForward[]}
 */
export function importPortForwardsFromLive(liveRows) {
  /** @type {Set<string>} */
  const usedIds = new Set();
  return liveRows.map((row) => liveRowToConfigEntry(row, usedIds));
}

/**
 * @param {unknown} raw
 */
/**
 * @param {unknown} raw
 * @param {Record<string, string>} [wanIps]
 */
export function normalizePortForwardConfigEntry(raw, wanIps = {}) {
  if (!isObject(raw)) {
    throw new Error("port_forwards[] entry must be an object");
  }
  const id = strField(raw.id);
  if (!id) throw new Error("port_forwards[].id is required");
  const name = strField(raw.name);
  if (!name) throw new Error(`port_forwards[${id}].name is required`);
  const fwd = strField(raw.fwd);
  if (!fwd) throw new Error(`port_forwards[${id}].fwd is required`);
  const dst_port = strField(raw.dst_port);
  if (!dst_port) throw new Error(`port_forwards[${id}].dst_port is required`);
  /** @type {ConfigPortForward} */
  const entry = {
    id,
    managed: raw.managed !== false,
    name,
    enabled: raw.enabled !== false,
    pfwd_interface: strField(raw.pfwd_interface) || "WAN",
    proto: strField(raw.proto) || "tcp_udp",
    dst_port,
    fwd,
    fwd_port: strField(raw.fwd_port),
    log: raw.log === true,
    src: strField(raw.src) || "any",
  };
  const destinationIp = strField(raw.destination_ip);
  if (destinationIp) entry.destination_ip = destinationIp;
  entry.destination_ip = resolveDestinationIp(entry, wanIps);
  const srcPort = strField(raw.src_port);
  if (srcPort) entry.src_port = srcPort;
  const srcGroup = strField(raw.src_firewall_group_id);
  if (srcGroup) entry.src_firewall_group_id = srcGroup;
  const dstGroup = strField(raw.dst_firewall_group_id);
  if (dstGroup) entry.dst_firewall_group_id = dstGroup;
  const unifiId = strField(raw.unifi_id);
  if (unifiId) entry.unifi_id = unifiId;
  return entry;
}

/**
 * @param {Record<string, unknown>} cfg
 */
/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizeWanIps(raw) {
  if (!isObject(raw)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const ip = strField(value);
    if (!ip) continue;
    const trimmedKey = strField(key);
    if (!trimmedKey) continue;
    out[trimmedKey] = ip;
    if (trimmedKey.startsWith(".")) {
      out[trimmedKey.slice(1)] = ip;
    } else {
      out[`.${trimmedKey}`] = ip;
    }
  }
  return out;
}

export function normalizeUnifiConfig(cfg) {
  const controllerBaseUrl =
    typeof cfg.controller_base_url === "string" && cfg.controller_base_url.trim()
      ? cfg.controller_base_url.trim()
      : "";
  const defaultSiteId =
    typeof cfg.default_site_id === "string" ? cfg.default_site_id.trim() : "";
  const wanIps = normalizeWanIps(cfg.wan_ips);

  /** @type {ConfigPortForward[]} */
  const portForwards = [];
  if (Array.isArray(cfg.port_forwards)) {
    for (const raw of cfg.port_forwards) {
      portForwards.push(normalizePortForwardConfigEntry(raw, wanIps));
    }
  }

  /** @type {Map<string, ConfigPortForward>} */
  const portForwardsById = new Map();
  for (const pf of portForwards) {
    if (portForwardsById.has(pf.id)) {
      throw new Error(`Duplicate port_forwards[].id in config: ${pf.id}`);
    }
    portForwardsById.set(pf.id, pf);
  }

  return {
    controllerBaseUrl,
    defaultSiteId,
    wanIps,
    portForwards,
    portForwardsById,
    managedPortForwards: portForwards.filter((p) => p.managed !== false),
    ipBlock: normalizeIpBlockConfig(cfg.ip_block),
    clientAliases: normalizeClientAliasesConfig(cfg.client_aliases),
  };
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean }}
 */
export function normalizeClientAliasesConfig(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  return { enabled: o.enabled === true };
}

/**
 * @param {unknown} raw
 */
export function normalizeIpBlockConfig(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  const groupName =
    typeof o.group_name === "string" && o.group_name.trim()
      ? o.group_name.trim()
      : "hdc-auto-block";
  /** @type {string[]} */
  let neverBlockCidrs = [];
  if (Array.isArray(o.never_block_cidrs)) {
    neverBlockCidrs = o.never_block_cidrs
      .filter((c) => typeof c === "string" && c.trim())
      .map((c) => String(c).trim());
  }
  const defaultDays =
    typeof o.default_days === "number" && Number.isFinite(o.default_days) && o.default_days > 0
      ? o.default_days
      : 30;
  return { groupName, neverBlockCidrs, defaultDays };
}

/**
 * @param {ConfigPortForward} entry
 */
export function portForwardPassesFilter(entry, ruleId) {
  if (!ruleId) return true;
  return entry.id === ruleId;
}

/**
 * @param {Record<string, unknown>} row
 */
export function formatPortForwardBlock(row) {
  const lines = [];
  const name = typeof row.name === "string" ? row.name : "(unnamed)";
  const enabled = row.enabled === false ? "disabled" : "enabled";
  lines.push(`— ${name} (${enabled})`);
  const proto = typeof row.proto === "string" ? row.proto : "";
  const dst = row.dst_port !== undefined ? String(row.dst_port) : "";
  const fwd = typeof row.fwd === "string" ? row.fwd : "";
  const fwdPort = row.fwd_port !== undefined ? String(row.fwd_port) : "";
  if (proto || dst) {
    const to = fwd ? ` → ${fwd}${fwdPort ? `:${fwdPort}` : ""}` : "";
    lines.push(`  ${proto || "tcp/udp"} WAN:${dst || "?"}${to}`);
  }
  if (typeof row.pfwd_interface === "string" && row.pfwd_interface) {
    lines.push(`  Interface: ${row.pfwd_interface}`);
  }
  if (typeof row.destination_ip === "string" && row.destination_ip) {
    lines.push(`  WAN IP: ${row.destination_ip}`);
  }
  lines.push("");
  return lines.join("\n");
}
