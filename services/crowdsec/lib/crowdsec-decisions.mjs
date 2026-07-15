import {
  DEFAULT_NEVER_BLOCK_CIDRS,
  isInternalIp,
  isValidIpv4,
} from "../../../infrastructure/unifi-network/lib/unifi-ip-block.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @typedef {{ value: string, type?: string, scenario?: string, origin?: string, duration?: string, created_at?: string }} CrowdsecDecision
 */

/**
 * @param {unknown} raw
 * @returns {CrowdsecDecision[]}
 */
export function parseCrowdsecDecisionsJson(raw) {
  if (!raw) return [];
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(data)) {
    return data.filter(isObject).map(normalizeDecision).filter((d) => d.value);
  }
  if (isObject(data) && Array.isArray(data.new)) {
    return data.new.filter(isObject).map(normalizeDecision).filter((d) => d.value);
  }
  return [];
}

/** @param {Record<string, unknown>} row */
function normalizeDecision(row) {
  const value =
    typeof row.value === "string"
      ? row.value.trim()
      : typeof row.ip === "string"
        ? row.ip.trim()
        : "";
  return {
    value,
    type: typeof row.type === "string" ? row.type : undefined,
    scenario: typeof row.scenario === "string" ? row.scenario : undefined,
    origin: typeof row.origin === "string" ? row.origin : undefined,
    duration: typeof row.duration === "string" ? row.duration : undefined,
    created_at: typeof row.created_at === "string" ? row.created_at : undefined,
  };
}

/**
 * @param {CrowdsecDecision[]} decisions
 * @param {{ neverBlockCidrs?: string[]; maxDecisions?: number }} [opts]
 */
export function filterBanDecisionsForUnifi(decisions, opts = {}) {
  const cidrs = opts.neverBlockCidrs?.length ? opts.neverBlockCidrs : DEFAULT_NEVER_BLOCK_CIDRS;
  const max = Number.isFinite(opts.maxDecisions) && opts.maxDecisions > 0 ? opts.maxDecisions : 15000;

  const bans = decisions.filter((d) => {
    if (!d.value) return false;
    if (d.type && d.type !== "ban") return false;
    if (!isValidIpv4(d.value)) return false;
    if (isInternalIp(d.value, cidrs)) return false;
    return true;
  });

  bans.sort((a, b) => decisionScore(b) - decisionScore(a));

  const seen = new Set();
  /** @type {string[]} */
  const ips = [];
  for (const d of bans) {
    if (seen.has(d.value)) continue;
    seen.add(d.value);
    ips.push(d.value);
    if (ips.length >= max) break;
  }
  return {
    ips,
    total_bans: bans.length,
    capped: bans.length > max,
    max_decisions: max,
  };
}

/** @param {CrowdsecDecision} d */
function decisionScore(d) {
  let score = 0;
  if (d.origin === "cscli" || d.origin === "CAPI") score += 10;
  if (d.scenario?.includes("ssh")) score += 50;
  if (d.scenario?.includes("unifi")) score += 40;
  if (d.created_at) {
    const t = Date.parse(d.created_at);
    if (Number.isFinite(t)) score += Math.floor(t / 1_000_000_000);
  }
  return score;
}

/**
 * @param {unknown} crowdsec
 * @param {unknown} bouncer
 */
export function unifiBouncerNeverBlockCidrs(crowdsec, bouncer) {
  const fromBouncer =
    isObject(bouncer) && Array.isArray(bouncer.never_block_cidrs) ? bouncer.never_block_cidrs : [];
  const fromCrowdsec =
    isObject(crowdsec) && Array.isArray(crowdsec.never_block_cidrs) ? crowdsec.never_block_cidrs : [];
  const merged = [...fromBouncer, ...fromCrowdsec]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim());
  return merged.length ? merged : [...DEFAULT_NEVER_BLOCK_CIDRS];
}

/**
 * @param {unknown} bouncer
 */
export function unifiBouncerMaxDecisions(bouncer) {
  if (!isObject(bouncer)) return 15000;
  const n = typeof bouncer.max_decisions === "number" ? bouncer.max_decisions : Number(bouncer.max_decisions);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

/**
 * @param {unknown} bouncer
 */
export function unifiBouncerGroupName(bouncer) {
  if (!isObject(bouncer)) return "crowdsec-block";
  const name = typeof bouncer.group_name === "string" ? bouncer.group_name.trim() : "";
  return name || "crowdsec-block";
}
