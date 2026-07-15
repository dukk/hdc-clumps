import { join } from "node:path";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { createUnifiRunContext } from "../../../infrastructure/unifi-network/lib/unifi-collect.mjs";
import { ensureFirewallAddressGroup } from "../../../infrastructure/unifi-network/lib/unifi-ip-block.mjs";
import { crowdsecLapiPort } from "./deployments.mjs";
import {
  filterBanDecisionsForUnifi,
  parseCrowdsecDecisionsJson,
  unifiBouncerGroupName,
  unifiBouncerMaxDecisions,
  unifiBouncerNeverBlockCidrs,
} from "./crowdsec-decisions.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function listBanDecisionsInCt(user, pveHost, vmid) {
  const r = pctExec(
    user,
    pveHost,
    vmid,
    "cscli decisions list -o json 2>/dev/null || cscli decisions list -o raw",
    { capture: true },
  );
  if (r.status !== 0) {
    return { ok: false, message: `cscli decisions list failed (exit ${r.status})`, stderr: r.stderr?.slice(0, 400) };
  }
  const decisions = parseCrowdsecDecisionsJson(r.stdout);
  return { ok: true, decisions, raw_count: decisions.length };
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.lapiUser
 * @param {string} opts.lapiHost
 * @param {number} opts.lapiVmid
 * @param {string | null} opts.lapiIp
 * @param {Record<string, unknown>} opts.crowdsec
 * @param {Record<string, unknown>} opts.bouncer
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.dryRun]
 */
export async function syncUnifiCrowdsecBouncer(opts) {
  const log = opts.log ?? (() => {});
  const lapiIp = typeof opts.lapiIp === "string" && opts.lapiIp.trim() ? opts.lapiIp.trim() : null;
  if (!lapiIp) {
    return { ok: false, message: "unable to resolve CrowdSec CT IP for UniFi bouncer sync" };
  }
  if (opts.bouncer.enabled === false || opts.bouncer.enabled === 0) {
    return { ok: true, skipped: true, message: "unifi bouncer disabled in config" };
  }

  const groupName = unifiBouncerGroupName(opts.bouncer);
  const maxDecisions = unifiBouncerMaxDecisions(opts.bouncer);
  const neverBlockCidrs = unifiBouncerNeverBlockCidrs(opts.crowdsec, opts.bouncer);

  const listed = listBanDecisionsInCt(opts.lapiUser, opts.lapiHost, opts.lapiVmid);
  if (!listed.ok) {
    return { ok: false, message: listed.message, bouncer_type: "unifi", group_name: groupName };
  }

  const filtered = filterBanDecisionsForUnifi(listed.decisions, {
    neverBlockCidrs,
    maxDecisions,
  });

  const unifiRoot = join(opts.repoRoot, "clumps", "infrastructure", "unifi-network");
  const ctx = await createUnifiRunContext({ clumpRoot: unifiRoot, log });
  const classicSiteKey = ctx.classicSiteKey;

  log(`UniFi bouncer: syncing ${filtered.ips.length} IP(s) to group ${groupName} (total bans ${filtered.total_bans})`);

  const groupResult = await ensureFirewallAddressGroup({
    base: ctx.base,
    apiKey: ctx.apiKey,
    classicSiteKey,
    rejectUnauthorized: ctx.rejectUnauthorized,
    groupName,
    members: filtered.ips,
    dryRun: opts.dryRun === true,
    log,
  });

  const lapiPort = crowdsecLapiPort(opts.crowdsec);
  return {
    ok: true,
    bouncer_type: "unifi",
    group_name: groupName,
    lapi_url: `http://${lapiIp}:${lapiPort}`,
    members: filtered.ips.length,
    total_bans: filtered.total_bans,
    capped: filtered.capped,
    max_decisions: filtered.max_decisions,
    group_action: groupResult.action,
    dry_run: opts.dryRun === true,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function queryDecisionCountInCt(user, pveHost, vmid) {
  const listed = listBanDecisionsInCt(user, pveHost, vmid);
  if (!listed.ok) {
    return { ok: false, message: listed.message };
  }
  const filtered = filterBanDecisionsForUnifi(listed.decisions);
  return {
    ok: true,
    raw_decisions: listed.raw_count,
    ban_decisions: filtered.total_bans,
    syncable_ips: filtered.ips.length,
    capped: filtered.capped,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function queryBouncersInCt(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "cscli bouncers list -o json 2>/dev/null || cscli bouncers list", {
    capture: true,
  });
  if (r.status !== 0) {
    return { ok: false, raw: r.stderr?.trim() || null };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    const names = Array.isArray(parsed)
      ? parsed.map((row) => (typeof row?.name === "string" ? row.name : null)).filter(Boolean)
      : [];
    return { ok: true, bouncers: names, count: names.length };
  } catch {
    return { ok: true, bouncers: [], raw: r.stdout.trim() };
  }
}
