import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";

const SHELL_PATH_EXPORT =
  'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"';

/** @type {RegExp} */
export const FQDN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * @param {string} domain
 */
export function normalizeDomain(domain) {
  return String(domain).trim().toLowerCase();
}

/**
 * @param {string} domain
 */
export function isValidAllowlistDomain(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized || normalized.length > 253) return false;
  if (normalized.includes("*") || normalized.includes(" ")) return false;
  return FQDN_PATTERN.test(normalized);
}

/**
 * @param {unknown} entry
 * @returns {{ domain: string, comment?: string }}
 */
function parseAllowlistEntry(entry) {
  if (typeof entry === "string") {
    const domain = normalizeDomain(entry);
    if (!isValidAllowlistDomain(domain)) {
      throw new Error(`invalid allowlist domain ${JSON.stringify(entry)}`);
    }
    return { domain };
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const row = /** @type {Record<string, unknown>} */ (entry);
    const domain =
      typeof row.domain === "string" ? normalizeDomain(row.domain) : "";
    if (!isValidAllowlistDomain(domain)) {
      throw new Error(`invalid allowlist domain object ${JSON.stringify(entry)}`);
    }
    const comment =
      typeof row.comment === "string" && row.comment.trim() ? row.comment.trim() : undefined;
    return comment ? { domain, comment } : { domain };
  }
  throw new Error(`allowlist entries must be strings or { domain, comment? } objects`);
}

/**
 * @param {Record<string, unknown>} pihole
 * @returns {{ domain: string, comment?: string }[]}
 */
export function allowlistFromPiholeConfig(pihole) {
  const raw = pihole.allowlist;
  if (!Array.isArray(raw)) return [];
  /** @type {Map<string, { domain: string, comment?: string }>} */
  const byDomain = new Map();
  for (const entry of raw) {
    const parsed = parseAllowlistEntry(entry);
    byDomain.set(parsed.domain, parsed);
  }
  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseAllowlistListOutput(stdout) {
  const stripped = String(stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
  /** @type {Set<string>} */
  const domains = new Set();
  for (const match of stripped.matchAll(/-\s*"([^"]+)"/g)) {
    const domain = normalizeDomain(match[1]);
    if (isValidAllowlistDomain(domain)) domains.add(domain);
  }
  for (const line of stripped.split("\n")) {
    const trimmed = line.trim();
    const unquoted = trimmed.replace(/^-\s*/, "").replace(/^"|"$/g, "");
    const domain = normalizeDomain(unquoted);
    if (isValidAllowlistDomain(domain)) domains.add(domain);
  }
  return [...domains].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} value
 */
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {{ domain: string, comment?: string }[]} desired
 * @param {{ prune?: boolean, liveDomains?: string[] }} [opts]
 */
export function buildAllowlistSyncScript(desired, opts = {}) {
  const prune = opts.prune === true;
  const liveDomains = Array.isArray(opts.liveDomains) ? opts.liveDomains : [];
  const desiredSet = new Set(desired.map((entry) => entry.domain));
  const liveSet = new Set(liveDomains.map((domain) => normalizeDomain(domain)).filter(Boolean));

  /** @type {{ domain: string, comment?: string }[]} */
  const toAdd = desired.filter((entry) => !liveSet.has(entry.domain));
  /** @type {string[]} */
  const toRemove = prune ? [...liveSet].filter((domain) => !desiredSet.has(domain)).sort() : [];

  if (!toAdd.length && !toRemove.length) {
    return {
      script: null,
      added: [],
      removed: [],
      noop: true,
      desired_count: desired.length,
      live_count: liveSet.size,
    };
  }

  const lines = [
    "set -euo pipefail",
    SHELL_PATH_EXPORT,
    "command -v pihole >/dev/null",
  ];

  /** @type {Map<string, { domain: string, comment?: string }[]>} */
  const addGroups = new Map();
  for (const entry of toAdd) {
    const key = entry.comment ?? "";
    const group = addGroups.get(key) ?? [];
    group.push(entry);
    addGroups.set(key, group);
  }

  for (const [comment, entries] of addGroups) {
    const args = entries.map((entry) => shellSingleQuote(entry.domain)).join(" ");
    if (comment) {
      lines.push(
        `pihole allow -q --comment ${shellSingleQuote(comment)} ${args} 2>/dev/null || true`,
      );
    } else {
      lines.push(`pihole allow -q ${args} 2>/dev/null || pihole -w -q ${args} 2>/dev/null || true`);
    }
  }

  if (toRemove.length) {
    const args = toRemove.map((domain) => shellSingleQuote(domain)).join(" ");
    lines.push(
      `pihole allow remove -q ${args} 2>/dev/null || pihole -w -d -q ${args} 2>/dev/null || true`,
    );
  }

  return {
    script: lines.join("\n"),
    added: toAdd.map((entry) => entry.domain),
    removed: toRemove,
    noop: false,
    desired_count: desired.length,
    live_count: liveSet.size,
  };
}

const LIST_ALLOWLIST_SCRIPT = [
  "set -euo pipefail",
  SHELL_PATH_EXPORT,
  "command -v pihole >/dev/null",
  "pihole allow --list -q 2>/dev/null || pihole -w -l -q 2>/dev/null || true",
].join("\n");

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function queryLiveAllowlistInCt(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, LIST_ALLOWLIST_SCRIPT, { capture: true });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `allowlist list failed (exit ${r.status})`,
      domains: [],
    };
  }
  const domains = parseAllowlistListOutput(r.stdout);
  return { ok: true, domains, count: domains.length };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} pihole
 * @param {{ prune?: boolean, skip?: boolean }} [opts]
 */
export function syncPiHoleAllowlistInCt(user, pveHost, vmid, pihole, opts = {}) {
  if (opts.skip) {
    errout.write(`[hdc] pi-hole allowlist: skipped on CT ${vmid} (--skip-allowlist).\n`);
    return { ok: true, skipped: true, message: "skipped" };
  }

  let desired;
  try {
    desired = allowlistFromPiholeConfig(pihole);
  } catch (e) {
    const message = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] pi-hole allowlist: invalid config on CT ${vmid}: ${message}\n`);
    return { ok: false, message };
  }

  const prune = opts.prune === true;
  if (!desired.length && !prune) {
    errout.write(`[hdc] pi-hole allowlist: no domains configured for CT ${vmid} — skipping.\n`);
    return { ok: true, skipped: true, message: "no allowlist configured", desired_count: 0 };
  }

  errout.write(
    `[hdc] pi-hole allowlist: syncing ${desired.length} configured domain(s) on CT ${vmid}${prune ? " (prune enabled)" : ""} …\n`,
  );

  const live = queryLiveAllowlistInCt(user, pveHost, vmid);
  if (!live.ok) {
    return { ok: false, message: live.message ?? "allowlist list failed", desired_count: desired.length };
  }

  const built = buildAllowlistSyncScript(desired, { prune, liveDomains: live.domains });
  if (built.noop || !built.script) {
    errout.write(`[hdc] pi-hole allowlist: CT ${vmid} already matches config.\n`);
    return {
      ok: true,
      skipped: false,
      noop: true,
      desired_count: built.desired_count,
      live_count: built.live_count,
      added: [],
      removed: [],
    };
  }

  const sync = pctExec(user, pveHost, vmid, built.script, { capture: true });
  if (sync.status !== 0) {
    return {
      ok: false,
      message: `allowlist sync failed (exit ${sync.status})`,
      stderr: sync.stderr?.slice(0, 500),
      desired_count: built.desired_count,
      added: built.added,
      removed: built.removed,
    };
  }

  errout.write(
    `[hdc] pi-hole allowlist: CT ${vmid} added ${built.added.length}, removed ${built.removed.length}.\n`,
  );
  return {
    ok: true,
    desired_count: built.desired_count,
    live_count: built.live_count,
    added: built.added,
    removed: built.removed,
    noop: false,
  };
}
