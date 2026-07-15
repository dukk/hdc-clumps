/**
 * HDC-managed UniFi source-IP blocks (firewall address-group + local expiry ledger).
 * UniFi has no native TTL — expiry is enforced by maintain --prune-expired / routine sync.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { classicRestListWithFallback, classicRestWrite } from "./unifi-api.mjs";
import { hdcPrivateRoot } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";

/** Default site CIDRs that must never be blocked (from ip-allocations.md). */
export const DEFAULT_NEVER_BLOCK_CIDRS = Object.freeze([
  "10.0.0.0/24",
  "10.0.5.0/26",
  "10.1.0.0/26",
  "10.1.1.0/26",
  "10.1.3.0/26",
  "10.2.0.0/26",
  "10.2.1.0/27",
  "10.2.2.0/26",
  "10.2.9.0/27",
  "192.168.12.0/24",
  "192.168.100.0/24",
  "127.0.0.0/8",
  "::1/128",
]);

export const DEFAULT_BLOCK_GROUP_NAME = "hdc-auto-block";
export const IP_BLOCKS_REL = "operations/ip-blocks.json";

/**
 * @param {string} ip
 * @returns {boolean}
 */
export function isValidIpv4(ip) {
  const parts = String(ip).trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/**
 * @param {string} ip
 * @param {string} cidr e.g. 10.0.0.0/24
 */
export function ipv4InCidr(ip, cidr) {
  const [net, bitsStr] = String(cidr).split("/");
  const bits = Number(bitsStr);
  if (!isValidIpv4(ip) || !isValidIpv4(net) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const ipN = ipv4ToInt(ip);
  const netN = ipv4ToInt(net);
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipN & mask) === (netN & mask);
}

/** @param {string} ip */
function ipv4ToInt(ip) {
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/**
 * @param {string} ip
 * @param {string[]} cidrs
 */
export function isInternalIp(ip, cidrs = DEFAULT_NEVER_BLOCK_CIDRS) {
  const trimmed = String(ip).trim();
  if (!isValidIpv4(trimmed)) return true; // refuse non-IPv4 / malformed as "internal" guard
  return cidrs.some((c) => ipv4InCidr(trimmed, c));
}

/**
 * @param {string} [publicRoot]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveIpBlocksPath(publicRoot = repoRoot(), env = process.env) {
  const privateRoot = hdcPrivateRoot(publicRoot, env);
  if (privateRoot) return join(privateRoot, IP_BLOCKS_REL);
  return join(publicRoot, IP_BLOCKS_REL);
}

/**
 * @typedef {{ ip: string, expires_at: string, reason?: string, blocked_at?: string, unifi_group_id?: string }} IpBlockEntry
 * @typedef {{ schema_version: number, group_name: string, blocks: IpBlockEntry[] }} IpBlocksLedger
 */

/**
 * @param {string} path
 * @returns {IpBlocksLedger}
 */
export function loadIpBlocksLedger(path) {
  if (!existsSync(path)) {
    return { schema_version: 1, group_name: DEFAULT_BLOCK_GROUP_NAME, blocks: [] };
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const blocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
  return {
    schema_version: 1,
    group_name:
      typeof raw?.group_name === "string" && raw.group_name.trim()
        ? raw.group_name.trim()
        : DEFAULT_BLOCK_GROUP_NAME,
    blocks: blocks
      .filter((b) => b && typeof b.ip === "string" && typeof b.expires_at === "string")
      .map((b) => ({
        ip: String(b.ip).trim(),
        expires_at: String(b.expires_at),
        reason: typeof b.reason === "string" ? b.reason : undefined,
        blocked_at: typeof b.blocked_at === "string" ? b.blocked_at : undefined,
        unifi_group_id: typeof b.unifi_group_id === "string" ? b.unifi_group_id : undefined,
      })),
  };
}

/**
 * @param {string} path
 * @param {IpBlocksLedger} ledger
 */
export function saveIpBlocksLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/**
 * @param {IpBlocksLedger} ledger
 * @param {Date} [now]
 */
export function activeBlockIps(ledger, now = new Date()) {
  const t = now.getTime();
  return ledger.blocks
    .filter((b) => {
      const exp = Date.parse(b.expires_at);
      return Number.isFinite(exp) && exp > t;
    })
    .map((b) => b.ip);
}

/**
 * @param {IpBlocksLedger} ledger
 * @param {Date} [now]
 */
export function pruneExpiredBlocks(ledger, now = new Date()) {
  const t = now.getTime();
  const kept = [];
  const removed = [];
  for (const b of ledger.blocks) {
    const exp = Date.parse(b.expires_at);
    if (Number.isFinite(exp) && exp > t) kept.push(b);
    else removed.push(b);
  }
  return { ledger: { ...ledger, blocks: kept }, removed };
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} groupName
 */
export function findFirewallGroupByName(rows, groupName) {
  const want = groupName.trim().toLowerCase();
  return rows.find((r) => {
    const n = typeof r.name === "string" ? r.name.trim().toLowerCase() : "";
    return n === want;
  });
}

/**
 * @param {object} opts
 * @param {string} opts.base
 * @param {string} opts.apiKey
 * @param {string} opts.classicSiteKey
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.groupName
 * @param {string[]} opts.members active IPs
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureFirewallAddressGroup(opts) {
  const log = opts.log ?? (() => {});
  const listed = await classicRestListWithFallback(
    opts.base,
    opts.apiKey,
    opts.classicSiteKey,
    "firewallgroup",
    opts.rejectUnauthorized,
  );
  const siteKey = listed.siteKey;
  const existing = findFirewallGroupByName(listed.rows, opts.groupName);
  const members = [...new Set(opts.members.map((m) => String(m).trim()).filter(isValidIpv4))].sort();

  const body = {
    name: opts.groupName,
    group_type: "address-group",
    group_members: members,
  };

  if (existing) {
    const rowId = typeof existing._id === "string" ? existing._id : "";
    if (!rowId) throw new Error(`firewall group ${opts.groupName} missing _id`);
    if (opts.dryRun) {
      log(`dry-run: would PUT firewallgroup ${opts.groupName} members=${members.length}`);
      return { action: "update", dryRun: true, groupId: rowId, members, siteKey };
    }
    await classicRestWrite(
      opts.base,
      opts.apiKey,
      siteKey,
      "firewallgroup",
      "PUT",
      { ...body, _id: rowId },
      rowId,
      opts.rejectUnauthorized,
    );
    log(`Updated firewall group ${opts.groupName} (${members.length} member(s))`);
    return { action: "update", dryRun: false, groupId: rowId, members, siteKey };
  }

  if (opts.dryRun) {
    log(`dry-run: would POST firewallgroup ${opts.groupName} members=${members.length}`);
    return { action: "create", dryRun: true, groupId: null, members, siteKey };
  }
  const created = await classicRestWrite(
    opts.base,
    opts.apiKey,
    siteKey,
    "firewallgroup",
    "POST",
    body,
    null,
    opts.rejectUnauthorized,
  );
  const data = Array.isArray(created?.data) ? created.data[0] : null;
  const groupId = data && typeof data._id === "string" ? data._id : null;
  log(`Created firewall group ${opts.groupName} (${members.length} member(s))`);
  return { action: "create", dryRun: false, groupId, members, siteKey };
}

/**
 * @param {object} opts
 * @param {string} opts.ip
 * @param {number} [opts.days]
 * @param {string} [opts.reason]
 * @param {string[]} [opts.neverBlockCidrs]
 * @param {IpBlocksLedger} opts.ledger
 * @param {Date} [opts.now]
 */
export function planBlockIp(opts) {
  const ip = String(opts.ip).trim();
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 30;
  const cidrs = opts.neverBlockCidrs ?? DEFAULT_NEVER_BLOCK_CIDRS;
  if (!isValidIpv4(ip)) {
    return { ok: false, error: `invalid IPv4: ${ip}` };
  }
  if (isInternalIp(ip, cidrs)) {
    return { ok: false, error: `refusing to block internal/site IP ${ip}` };
  }
  const now = opts.now ?? new Date();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const blocks = opts.ledger.blocks.filter((b) => b.ip !== ip);
  blocks.push({
    ip,
    expires_at: expires.toISOString(),
    reason: opts.reason,
    blocked_at: now.toISOString(),
  });
  return {
    ok: true,
    ledger: { ...opts.ledger, blocks },
    entry: blocks[blocks.length - 1],
  };
}

/**
 * @param {object} opts
 * @param {string} opts.ip
 * @param {IpBlocksLedger} opts.ledger
 */
export function planUnblockIp(opts) {
  const ip = String(opts.ip).trim();
  const before = opts.ledger.blocks.length;
  const blocks = opts.ledger.blocks.filter((b) => b.ip !== ip);
  return {
    ok: true,
    removed: before - blocks.length,
    ledger: { ...opts.ledger, blocks },
  };
}
