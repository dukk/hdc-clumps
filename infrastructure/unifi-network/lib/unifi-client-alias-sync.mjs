/**
 * Sync UniFi client aliases (name) to Proxmox guest inventory system ids.
 * Match by IP (primary) and MAC when present in inventory.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { MANUAL_SYSTEMS, manualSidecarRel } from "hdc/cli/lib/inventory-paths.mjs";
import { hdcPrivateRoot, readResolvedRepoJson, resolveRepoFile } from "hdc/cli/lib/private-repo.mjs";
import { classicRestUsers, classicSetClientName, classicUserByMac, classicActiveStations } from "./unifi-api.mjs";

/**
 * @typedef {object} GuestDesired
 * @property {string} systemId
 * @property {string} [ip]
 * @property {string} [mac]
 */

/**
 * @typedef {object} LiveClientView
 * @property {string} mac
 * @property {string} [ip]
 * @property {string} [name]
 * @property {string} [unifiId]
 */

/**
 * @typedef {object} AliasUpdate
 * @property {string} systemId
 * @property {string} mac
 * @property {string} [ip]
 * @property {string} [unifiId]
 * @property {string} [currentName]
 */

/**
 * @typedef {object} AliasSkip
 * @property {string} reason
 * @property {string} [systemId]
 * @property {string} [ip]
 * @property {string} [mac]
 */

/**
 * @param {string} mac
 */
export function normalizeMac(mac) {
  return String(mac ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, ":");
}

/**
 * @param {string} ip
 */
export function normalizeIp(ip) {
  return String(ip ?? "").trim();
}

/**
 * True when UniFi is showing the MAC (or empty) instead of a real alias.
 * @param {string | undefined} name
 * @param {string} mac
 */
export function nameNeedsAlias(name, mac) {
  const n = String(name ?? "").trim();
  if (!n) return true;
  const macN = normalizeMac(mac);
  if (!macN) return false;
  return normalizeMac(n) === macN;
}

/**
 * @param {unknown} system
 * @returns {boolean}
 */
export function isProxmoxGuestSystem(system) {
  if (!system || typeof system !== "object" || Array.isArray(system)) return false;
  const row = /** @type {Record<string, unknown>} */ (system);
  if (row.kind !== "system" && row.kind != null) return false;
  if (row.system_class !== "virtual") return false;
  const hosted = typeof row.hosted_on_system_id === "string" ? row.hosted_on_system_id.trim() : "";
  return /^pve-/i.test(hosted);
}

/**
 * @param {unknown} system
 * @returns {{ ip?: string; mac?: string }[]}
 */
function nodesFromSystem(system) {
  if (!system || typeof system !== "object" || Array.isArray(system)) return [];
  const access = /** @type {Record<string, unknown>} */ (system).access;
  if (!access || typeof access !== "object" || Array.isArray(access)) return [];
  const nodes = access.nodes;
  if (!Array.isArray(nodes)) return [];
  /** @type {{ ip?: string; mac?: string }[]} */
  const out = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object" || Array.isArray(n)) continue;
    const row = /** @type {Record<string, unknown>} */ (n);
    /** @type {{ ip?: string; mac?: string }} */
    const entry = {};
    if (typeof row.ip === "string" && row.ip.trim()) entry.ip = normalizeIp(row.ip);
    if (typeof row.mac === "string" && row.mac.trim()) entry.mac = normalizeMac(row.mac);
    if (entry.ip || entry.mac) out.push(entry);
  }
  return out;
}

/**
 * List manual system ids from public + private inventory dirs.
 * @param {string} publicRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function listManualSystemIds(publicRoot, env = process.env) {
  /** @type {Set<string>} */
  const ids = new Set();
  const privateRoot = hdcPrivateRoot(publicRoot, env);
  const dirs = [];
  if (privateRoot) dirs.push(join(privateRoot, MANUAL_SYSTEMS));
  dirs.push(join(publicRoot, MANUAL_SYSTEMS));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith("_")) continue;
      ids.add(name.replace(/\.json$/i, ""));
    }
  }
  return [...ids].sort();
}

/**
 * Build desired guest maps from inventory (Proxmox guests only).
 * @param {string} publicRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   byIp: Map<string, GuestDesired>;
 *   byMac: Map<string, GuestDesired>;
 *   guests: GuestDesired[];
 *   warnings: string[];
 * }}
 */
export function loadProxmoxGuestDesired(publicRoot, env = process.env) {
  /** @type {Map<string, GuestDesired>} */
  const byIp = new Map();
  /** @type {Map<string, GuestDesired>} */
  const byMac = new Map();
  /** @type {GuestDesired[]} */
  const guests = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, string>} */
  const ipOwners = new Map();
  /** @type {Map<string, string>} */
  const macOwners = new Map();

  for (const id of listManualSystemIds(publicRoot, env)) {
    const resolved = resolveRepoFile(publicRoot, manualSidecarRel("systems", id), env);
    if (!resolved.found) continue;
    let data;
    try {
      data = readResolvedRepoJson(resolved);
    } catch {
      continue;
    }
    if (!isProxmoxGuestSystem(data)) continue;
    const systemId = typeof data.id === "string" && data.id.trim() ? data.id.trim() : id;
    const nodes = nodesFromSystem(data);
    if (!nodes.length) {
      warnings.push(`guest ${systemId}: no access.nodes ip/mac; skipped`);
      continue;
    }
    for (const node of nodes) {
      /** @type {GuestDesired} */
      const desired = { systemId };
      if (node.ip) desired.ip = node.ip;
      if (node.mac) desired.mac = node.mac;
      guests.push(desired);

      if (node.ip) {
        const prev = ipOwners.get(node.ip);
        if (prev && prev !== systemId) {
          warnings.push(`duplicate inventory IP ${node.ip}: ${prev} and ${systemId}`);
          byIp.delete(node.ip);
        } else if (!prev) {
          ipOwners.set(node.ip, systemId);
          byIp.set(node.ip, desired);
        }
      }
      if (node.mac) {
        const prev = macOwners.get(node.mac);
        if (prev && prev !== systemId) {
          warnings.push(`duplicate inventory MAC ${node.mac}: ${prev} and ${systemId}`);
          byMac.delete(node.mac);
        } else if (!prev) {
          macOwners.set(node.mac, systemId);
          byMac.set(node.mac, desired);
        }
      }
    }
  }

  return { byIp, byMac, guests, warnings };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {LiveClientView | null}
 */
export function liveClientFromRow(row) {
  const macRaw =
    (typeof row.mac === "string" && row.mac) ||
    (typeof row.macAddress === "string" && row.macAddress) ||
    "";
  const mac = normalizeMac(macRaw);
  if (!mac) return null;
  const ipRaw =
    (typeof row.ip === "string" && row.ip) ||
    (typeof row.ipAddress === "string" && row.ipAddress) ||
    (typeof row.last_ip === "string" && row.last_ip) ||
    "";
  const ip = normalizeIp(ipRaw);
  const name =
    (typeof row.name === "string" && row.name.trim()) ||
    (typeof row.hostname === "string" && row.hostname.trim()) ||
    (typeof row.host_name === "string" && row.host_name.trim()) ||
    "";
  const unifiId =
    (typeof row._id === "string" && row._id.trim()) ||
    (typeof row.user_id === "string" && row.user_id.trim()) ||
    (typeof row.id === "string" && row.id.trim() && !String(row.id).includes(":") ? row.id.trim() : "") ||
    "";
  /** @type {LiveClientView} */
  const out = { mac };
  if (ip) out.ip = ip;
  if (name) out.name = name;
  if (unifiId) out.unifiId = unifiId;
  return out;
}

/**
 * Merge rest/user + active stations by MAC (prefer user name/_id, station IP when fresher).
 * @param {Record<string, unknown>[]} users
 * @param {Record<string, unknown>[]} stations
 * @returns {LiveClientView[]}
 */
export function mergeLiveClients(users, stations) {
  /** @type {Map<string, LiveClientView>} */
  const byMac = new Map();
  for (const raw of [...users, ...stations]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const view = liveClientFromRow(/** @type {Record<string, unknown>} */ (raw));
    if (!view) continue;
    const prev = byMac.get(view.mac);
    if (!prev) {
      byMac.set(view.mac, { ...view });
      continue;
    }
    if (!prev.unifiId && view.unifiId) prev.unifiId = view.unifiId;
    if (!prev.ip && view.ip) prev.ip = view.ip;
    // Prefer explicit alias (non-MAC name) from either source
    const prevNeeds = nameNeedsAlias(prev.name, prev.mac);
    const viewNeeds = nameNeedsAlias(view.name, view.mac);
    if (prevNeeds && !viewNeeds && view.name) prev.name = view.name;
    else if (!prev.name && view.name) prev.name = view.name;
  }
  return [...byMac.values()];
}

/**
 * @param {Map<string, GuestDesired>} byIp
 * @param {Map<string, GuestDesired>} byMac
 * @param {LiveClientView[]} live
 * @returns {{
 *   update: AliasUpdate[];
 *   unchanged: AliasUpdate[];
 *   skipped: AliasSkip[];
 *   summary: { update: number; unchanged: number; skipped: number };
 * }}
 */
export function planClientAliasSync(byIp, byMac, live) {
  /** @type {AliasUpdate[]} */
  const update = [];
  /** @type {AliasUpdate[]} */
  const unchanged = [];
  /** @type {AliasSkip[]} */
  const skipped = [];

  /** @type {Map<string, LiveClientView[]>} */
  const liveByIp = new Map();
  for (const c of live) {
    if (!c.ip) continue;
    const list = liveByIp.get(c.ip) ?? [];
    list.push(c);
    liveByIp.set(c.ip, list);
  }

  /** @type {Set<string>} */
  const matchedMacs = new Set();

  for (const [ip, desired] of byIp) {
    const candidates = liveByIp.get(ip) ?? [];
    if (!candidates.length) {
      skipped.push({ reason: "no UniFi client with this IP", systemId: desired.systemId, ip });
      continue;
    }
    if (candidates.length > 1) {
      skipped.push({
        reason: `ambiguous: ${candidates.length} UniFi clients share IP`,
        systemId: desired.systemId,
        ip,
      });
      continue;
    }
    const client = candidates[0];
    matchedMacs.add(client.mac);
    /** @type {AliasUpdate} */
    const row = {
      systemId: desired.systemId,
      mac: client.mac,
      ip,
      unifiId: client.unifiId,
      currentName: client.name,
    };
    if (client.name === desired.systemId) {
      unchanged.push(row);
    } else {
      update.push(row);
    }
  }

  for (const [mac, desired] of byMac) {
    if (matchedMacs.has(mac)) continue;
    const client = live.find((c) => c.mac === mac);
    if (!client) {
      skipped.push({ reason: "no UniFi client with this MAC", systemId: desired.systemId, mac });
      continue;
    }
    matchedMacs.add(mac);
    /** @type {AliasUpdate} */
    const row = {
      systemId: desired.systemId,
      mac,
      ip: client.ip ?? desired.ip,
      unifiId: client.unifiId,
      currentName: client.name,
    };
    if (client.name === desired.systemId) {
      unchanged.push(row);
    } else {
      update.push(row);
    }
  }

  return {
    update,
    unchanged,
    skipped,
    summary: {
      update: update.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
    },
  };
}

/**
 * @param {object} ctx
 * @param {string} ctx.base
 * @param {string} ctx.apiKey
 * @param {string} ctx.classicSiteKey
 * @param {boolean} ctx.rejectUnauthorized
 * @param {ReturnType<typeof planClientAliasSync>} plan
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} [opts.log]
 */
export async function applyClientAliasSync(ctx, plan, opts = {}) {
  const dryRun = opts.dryRun === true;
  const log = opts.log ?? (() => {});
  /** @type {{ action: string; systemId: string; mac: string; ok: boolean; error?: string }[]} */
  const results = [];
  let ok = true;

  for (const item of plan.update) {
    const label = `${item.systemId} (${item.mac}${item.ip ? ` ${item.ip}` : ""})`;
    if (dryRun) {
      log(`dry-run: would rename UniFi client ${label} ← ${JSON.stringify(item.currentName ?? "")}`);
      results.push({ action: "rename", systemId: item.systemId, mac: item.mac, ok: true });
      continue;
    }
    try {
      let userId = item.unifiId ?? "";
      if (!userId) {
        const looked = await classicUserByMac(
          ctx.base,
          ctx.apiKey,
          ctx.classicSiteKey,
          item.mac,
          ctx.rejectUnauthorized,
        );
        if (looked && typeof looked._id === "string") userId = looked._id.trim();
      }
      if (!userId) {
        throw new Error("could not resolve UniFi user _id for MAC");
      }
      await classicSetClientName(
        ctx.base,
        ctx.apiKey,
        ctx.classicSiteKey,
        userId,
        item.systemId,
        ctx.rejectUnauthorized,
      );
      log(`renamed UniFi client ${label}`);
      results.push({ action: "rename", systemId: item.systemId, mac: item.mac, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`FAILED rename ${label}: ${msg}`);
      results.push({ action: "rename", systemId: item.systemId, mac: item.mac, ok: false, error: msg });
      ok = false;
    }
  }

  return { ok, results };
}

/**
 * Fetch live users + stations for alias planning.
 * @param {object} ctx
 * @param {string} ctx.base
 * @param {string} ctx.apiKey
 * @param {string} ctx.classicSiteKey
 * @param {boolean} ctx.rejectUnauthorized
 * @param {(line: string) => void} [log]
 */
export async function fetchLiveClientsForAliasSync(ctx, log = () => {}) {
  log(`Listing known clients: GET …/rest/user (site ${ctx.classicSiteKey}) …`);
  const usersRes = await classicRestUsers(ctx.base, ctx.apiKey, ctx.classicSiteKey, ctx.rejectUnauthorized);
  ctx.classicSiteKey = usersRes.siteKey;
  log(`Known clients: ${usersRes.rows.length}`);

  log(`Listing active stations: POST …/stat/sta …`);
  const stations = await classicActiveStations(
    ctx.base,
    ctx.apiKey,
    ctx.classicSiteKey,
    ctx.rejectUnauthorized,
  );
  log(`Active stations: ${stations.length}`);

  return mergeLiveClients(usersRes.rows, stations);
}
