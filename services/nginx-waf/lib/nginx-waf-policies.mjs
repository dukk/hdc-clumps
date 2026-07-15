import { stderr as errout } from "node:process";

import {
  normalizeSourceCidr,
  parseIpv4Cidr,
} from "../../../infrastructure/proxmox/lib/proxmox-host-firewall-maintain.mjs";

const DEFAULT_TRUSTED_CIDRS = [
  "192.0.2.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
];

export const DEFAULT_CRS_SETUP = "/etc/modsecurity/crs/crs-setup.conf";
export const DEFAULT_CRS_RULES_GLOB = "/usr/share/modsecurity-crs/rules/*.conf";
export const DEFAULT_MODSEC_AUDIT_LOG = "/var/log/nginx/modsec_audit.log";

/**
 * @param {string[]} cidrs
 * @param {string} context
 */
function validateTrustedCidrs(cidrs, context) {
  if (!cidrs.length) {
    throw new Error(`${context}: trusted_cidrs must include at least one CIDR`);
  }
  for (const cidr of cidrs) {
    const normalized = normalizeSourceCidr(cidr);
    if (!parseIpv4Cidr(normalized)) {
      throw new Error(`${context}: invalid trusted CIDR ${JSON.stringify(cidr)}`);
    }
  }
}

/** @type {Set<string>} */
const legacyWarnings = new Set();

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} msg
 */
function warnOnce(key, msg) {
  if (legacyWarnings.has(key)) return;
  legacyWarnings.add(key);
  errout.write(`[hdc] nginx-waf: ${msg}\n`);
}

export const DEFAULT_MODSECURITY_PROFILE_ID = "modsecurity-default";
export const DEFAULT_INTERNAL_POLICY_ID = "internal-lan";

/**
 * @param {Record<string, unknown>} nw
 * @param {string[]} trustedCidrs
 */
export function seedPolicyCatalogFromLegacy(nw, trustedCidrs) {
  const ms = isObject(nw.modsecurity) ? nw.modsecurity : {};
  /** @type {Record<string, Record<string, unknown>>} */
  const catalog = {};
  catalog[DEFAULT_MODSECURITY_PROFILE_ID] = {
    type: "modsecurity",
    rule_engine:
      typeof ms.rule_engine === "string" && ms.rule_engine.trim() ? ms.rule_engine.trim() : "On",
    crs_setup:
      typeof ms.crs_setup === "string" && ms.crs_setup.trim()
        ? ms.crs_setup.trim()
        : DEFAULT_CRS_SETUP,
    crs_rules_glob:
      typeof ms.crs_rules_glob === "string" && ms.crs_rules_glob.trim()
        ? ms.crs_rules_glob.trim()
        : DEFAULT_CRS_RULES_GLOB,
    unicode_map: typeof ms.unicode_map === "string" ? ms.unicode_map.trim() : "",
    audit_log:
      typeof ms.audit_log === "string" && ms.audit_log.trim()
        ? ms.audit_log.trim()
        : DEFAULT_MODSEC_AUDIT_LOG,
    audit_log_format:
      typeof ms.audit_log_format === "string" && ms.audit_log_format.trim()
        ? ms.audit_log_format.trim()
        : "json",
  };
  catalog[DEFAULT_INTERNAL_POLICY_ID] = {
    type: "trusted_cidrs",
    deny_status: 404,
    groups: [{ id: "default", cidrs: [...trustedCidrs] }],
  };
  catalog["block-exploits"] = { type: "block_common_exploits" };
  catalog["hide-version"] = { type: "server_tokens", enabled: false };
  return catalog;
}

/**
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown>} [groupRaw]
 */
export function mergePolicyDefinitions(defaults, groupRaw) {
  const nw = isObject(defaults.nginx_waf) ? defaults.nginx_waf : {};
  const trustedCidrs = Array.isArray(nw.trusted_cidrs) && nw.trusted_cidrs.length
    ? nw.trusted_cidrs.map((c) => String(c).trim()).filter(Boolean)
    : [...DEFAULT_TRUSTED_CIDRS];
  const base = seedPolicyCatalogFromLegacy(nw, trustedCidrs);
  const defaultsDefs = isObject(nw.policy_definitions) ? nw.policy_definitions : {};
  for (const [key, val] of Object.entries(defaultsDefs)) {
    if (isObject(val)) base[key] = structuredClone(val);
  }
  const groupDefs =
    groupRaw && isObject(groupRaw.policy_definitions) ? groupRaw.policy_definitions : {};
  for (const [key, val] of Object.entries(groupDefs)) {
    if (isObject(val)) base[key] = structuredClone(val);
  }
  return base;
}

/**
 * @param {string} profileId
 */
export function modsecurityProfilePath(profileId) {
  const safe = String(profileId).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `/etc/modsecurity/hdc-waf-${safe}.conf`;
}

/**
 * @param {string} siteIdSlug
 */
export function trustedGeoVariableForSite(siteIdSlug) {
  return `$hdc_trusted_${siteIdSlug.replace(/-/g, "_")}`;
}

/**
 * @param {unknown} entry
 * @param {Record<string, Record<string, unknown>>} catalog
 * @param {string} context
 */
function resolvePolicyEntry(entry, catalog, context) {
  if (typeof entry === "string") {
    const ref = entry.trim();
    if (!ref) throw new Error(`${context}: empty policy ref`);
    const def = catalog[ref];
    if (!def) throw new Error(`${context}: unknown policy ref ${JSON.stringify(ref)}`);
    return { ...structuredClone(def), _ref: ref, _profileId: ref };
  }
  if (!isObject(entry) || typeof entry.type !== "string") {
    throw new Error(`${context}: policy entry must be string ref or { type, ... }`);
  }
  const type = entry.type.trim();
  if (typeof entry.ref === "string" && entry.ref.trim()) {
    const base = catalog[entry.ref.trim()];
    if (!base) throw new Error(`${context}: unknown policy ref ${JSON.stringify(entry.ref)}`);
    if (base.type !== type) {
      throw new Error(`${context}: policy ref ${entry.ref} type ${base.type} != ${type}`);
    }
    return { ...structuredClone(base), ...structuredClone(entry), _ref: entry.ref.trim(), _profileId: entry.ref.trim() };
  }
  return { ...structuredClone(entry), _profileId: type };
}

/**
 * @param {unknown[]} raw
 * @param {Record<string, Record<string, unknown>>} catalog
 * @param {string} context
 */
export function resolvePoliciesList(raw, catalog, context) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, i) => resolvePolicyEntry(entry, catalog, `${context} policies[${i}]`));
}

/**
 * Merge site + location policies; location wins per type.
 * @param {Record<string, unknown>[]} sitePolicies
 * @param {Record<string, unknown>[]} locationPolicies
 */
export function mergePoliciesByType(sitePolicies, locationPolicies) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byType = new Map();
  for (const p of sitePolicies) {
    byType.set(String(p.type), p);
  }
  for (const p of locationPolicies) {
    byType.set(String(p.type), p);
  }
  return [...byType.values()];
}

/**
 * @param {Record<string, unknown>} policy
 * @param {Record<string, Record<string, unknown>>} catalog
 * @param {string} context
 */
function resolveTrustedCidrGroups(policy, catalog, context) {
  /** @type {{ id: string, cidrs: string[] }[]} */
  const groups = [];
  const rawGroups = policy.groups;
  if (Array.isArray(rawGroups) && rawGroups.length) {
    for (const g of rawGroups) {
      if (typeof g === "string") {
        const refId = g.trim();
        let found = false;
        for (const def of Object.values(catalog)) {
          if (def.type !== "trusted_cidrs" || !Array.isArray(def.groups)) continue;
          for (const dg of def.groups) {
            if (isObject(dg) && dg.id === refId && Array.isArray(dg.cidrs)) {
              groups.push({ id: refId, cidrs: dg.cidrs.map((c) => String(c).trim()).filter(Boolean) });
              found = true;
              break;
            }
          }
        }
        if (!found) throw new Error(`${context}: unknown trusted_cidrs group ref ${JSON.stringify(refId)}`);
      } else if (isObject(g)) {
        const id = typeof g.id === "string" ? g.id.trim() : "group";
        const cidrs = Array.isArray(g.cidrs)
          ? g.cidrs.map((c) => String(c).trim()).filter(Boolean)
          : [];
        if (!cidrs.length) throw new Error(`${context}: trusted_cidrs group ${id} needs cidrs[]`);
        groups.push({ id, cidrs });
      }
    }
  }
  if (!groups.length) {
    throw new Error(`${context}: trusted_cidrs policy needs groups[]`);
  }
  const denyRaw = policy.deny_status;
  const denyStatus = denyRaw === 401 || denyRaw === 404 ? denyRaw : 404;
  /** @type {string[]} */
  const unionCidrs = [];
  for (const g of groups) {
    for (const c of g.cidrs) {
      if (!unionCidrs.includes(c)) unionCidrs.push(c);
    }
  }
  validateTrustedCidrs(unionCidrs, context);
  return { groups, unionCidrs, denyStatus };
}

/**
 * @param {Record<string, unknown>[]} policies
 * @param {Record<string, Record<string, unknown>>} catalog
 * @param {string} context
 */
export function normalizeResolvedPolicies(policies, catalog, context) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const p of policies) {
    const type = String(p.type);
    switch (type) {
      case "modsecurity": {
        const enabled = p.enabled !== false;
        const profileId =
          typeof p._profileId === "string" && p._profileId.trim()
            ? p._profileId.trim()
            : DEFAULT_MODSECURITY_PROFILE_ID;
        out.modsecurity = {
          type: "modsecurity",
          enabled,
          profileId,
          ruleEngine:
            typeof p.rule_engine === "string" && p.rule_engine.trim()
              ? p.rule_engine.trim()
              : "On",
          crsSetup:
            typeof p.crs_setup === "string" && p.crs_setup.trim()
              ? p.crs_setup.trim()
              : DEFAULT_CRS_SETUP,
          crsRulesGlob:
            typeof p.crs_rules_glob === "string" && p.crs_rules_glob.trim()
              ? p.crs_rules_glob.trim()
              : DEFAULT_CRS_RULES_GLOB,
          unicodeMap: typeof p.unicode_map === "string" ? p.unicode_map.trim() : "",
          auditLog:
            typeof p.audit_log === "string" && p.audit_log.trim()
              ? p.audit_log.trim()
              : DEFAULT_MODSEC_AUDIT_LOG,
          auditLogFormat:
            typeof p.audit_log_format === "string" && p.audit_log_format.trim()
              ? p.audit_log_format.trim()
              : typeof catalog[DEFAULT_MODSECURITY_PROFILE_ID]?.audit_log_format === "string"
                ? String(catalog[DEFAULT_MODSECURITY_PROFILE_ID].audit_log_format).trim()
                : "json",
        };
        break;
      }
      case "trusted_cidrs": {
        const resolved = resolveTrustedCidrGroups(p, catalog, context);
        out.trusted_cidrs = { type: "trusted_cidrs", ...resolved };
        break;
      }
      case "cloudflare_origin": {
        out.cloudflare_origin = {
          type: "cloudflare_origin",
          requireHeaders: p.require_headers !== false,
          requireCfRay: p.require_cf_ray === true,
          denyStatus: typeof p.deny_status === "number" ? p.deny_status : 403,
        };
        break;
      }
      case "server_tokens": {
        out.server_tokens = {
          type: "server_tokens",
          serverTokensOff: p.enabled === false,
        };
        break;
      }
      case "rate_limit": {
        const zoneName =
          typeof p.zone_name === "string" && p.zone_name.trim()
            ? p.zone_name.trim()
            : typeof p._ref === "string"
              ? p._ref.trim()
              : "hdc_rate";
        out.rate_limit = {
          type: "rate_limit",
          zoneName,
          key:
            typeof p.key === "string" && p.key.trim() ? p.key.trim() : "$binary_remote_addr",
          rate: typeof p.rate === "string" && p.rate.trim() ? p.rate.trim() : "10r/s",
          burst: typeof p.burst === "number" ? p.burst : 20,
          nodelay: p.nodelay !== false,
          zoneSize: typeof p.zone_size === "string" ? p.zone_size : "10m",
        };
        break;
      }
      case "client_buffers": {
        out.client_buffers = {
          type: "client_buffers",
          clientBodyBufferSize:
            typeof p.client_body_buffer_size === "string"
              ? p.client_body_buffer_size.trim()
              : "",
          clientHeaderBufferSize:
            typeof p.client_header_buffer_size === "string"
              ? p.client_header_buffer_size.trim()
              : "",
          largeClientHeaderBuffers:
            typeof p.large_client_header_buffers === "string"
              ? p.large_client_header_buffers.trim()
              : "",
        };
        break;
      }
      case "http_protocol": {
        out.http_protocol = {
          type: "http_protocol",
          minVersion:
            typeof p.min_version === "string" && p.min_version.trim()
              ? p.min_version.trim()
              : "1.1",
          denyStatus: typeof p.deny_status === "number" ? p.deny_status : 505,
        };
        break;
      }
      case "block_common_exploits": {
        out.block_common_exploits = { type: "block_common_exploits" };
        break;
      }
      default:
        throw new Error(`${context}: unknown policy type ${JSON.stringify(type)}`);
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} site
 * @param {string[]} defaultTrustedCidrs
 */
export function migrateSitePoliciesV4(site, defaultTrustedCidrs = DEFAULT_TRUSTED_CIDRS) {
  const out = { ...site };
  if (Array.isArray(out.policies) && out.policies.length) {
    if (Array.isArray(out.locations)) {
      out.locations = out.locations.map((loc) =>
        migrateLocationPoliciesV4(loc, defaultTrustedCidrs),
      );
    }
    return out;
  }

  /** @type {unknown[]} */
  const policies = [];
  const waf = isObject(out.waf) ? out.waf : {};
  if (Object.keys(waf).length) {
    warnOnce("waf", "site.waf is deprecated — use policies[] with modsecurity policy");
  }
  if (waf.enabled !== false) {
    policies.push(DEFAULT_MODSECURITY_PROFILE_ID);
  } else if (Object.keys(waf).length) {
    policies.push({ type: "modsecurity", enabled: false });
  }

  out.policies = policies;

  if (Array.isArray(out.locations)) {
    out.locations = out.locations.map((loc) =>
      migrateLocationPoliciesV4(loc, defaultTrustedCidrs),
    );
  }
  return out;
}

/**
 * @param {unknown} loc
 * @param {string[]} defaultTrustedCidrs
 */
export function migrateLocationPoliciesV4(loc, defaultTrustedCidrs) {
  if (!isObject(loc)) return loc;
  const out = { ...loc };
  if (Array.isArray(out.policies) && out.policies.length) return out;

  /** @type {unknown[]} */
  const policies = Array.isArray(out.policies) ? [...out.policies] : [];

  const access = isObject(out.access) ? out.access : null;
  if (access?.policy === "internal_only") {
    warnOnce(
      "access",
      "location.access.internal_only is deprecated — use policies: [\"internal-lan\"] or trusted_cidrs policy",
    );
    const denyStatus = access.deny_status === 401 || access.deny_status === 404 ? access.deny_status : 404;
    policies.push({
      type: "trusted_cidrs",
      deny_status: denyStatus,
      groups: [{ id: "default", cidrs: [...defaultTrustedCidrs] }],
    });
    delete out.access;
  }

  const locWaf = isObject(out.waf) ? out.waf : null;
  if (locWaf && locWaf.enabled === false) {
    warnOnce("loc-waf", "location.waf is deprecated — use policies: [{ type: modsecurity, enabled: false }]");
    policies.push({ type: "modsecurity", enabled: false });
    delete out.waf;
  }

  if (policies.length) out.policies = policies;
  return out;
}

/**
 * @param {Record<string, unknown>} site
 * @param {Record<string, Record<string, unknown>>} catalog
 * @param {string} siteContext
 */
export function resolveSitePolicyPlan(site, catalog, siteContext) {
  const sitePolicies = resolvePoliciesList(site.policies, catalog, siteContext);
  return normalizeResolvedPolicies(sitePolicies, catalog, siteContext);
}

/**
 * @param {Record<string, unknown>} site
 * @param {Record<string, unknown>} loc
 * @param {number} index
 * @param {Record<string, Record<string, unknown>>} catalog
 * @param {ReturnType<typeof resolveSitePolicyPlan>} sitePlan
 */
export function resolveLocationPolicyPlan(site, loc, index, catalog, sitePlan) {
  const id = typeof site.id === "string" ? site.id.trim() : "site";
  const ctx = `${id} location ${index}`;
  const sitePolicies = resolvePoliciesList(site.policies, catalog, id);
  const locPolicies = resolvePoliciesList(loc.policies, catalog, ctx);
  const merged = mergePoliciesByType(sitePolicies, locPolicies);
  return normalizeResolvedPolicies(merged, catalog, ctx);
}

/**
 * @param {Record<string, unknown>[]} sites
 * @param {Record<string, Record<string, unknown>>} catalog
 */
export function collectGroupPolicyPlan(sites, catalog) {
  /** @type {Map<string, Record<string, unknown>>} */
  const modsecurityProfiles = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const rateLimitZones = new Map();
  let blockCommonExploits = false;
  let usesModsecurity = false;

  for (const site of sites) {
    const id = typeof site.id === "string" ? site.id.trim() : "";
    const sitePlan = resolveSitePolicyPlan(site, catalog, id || "site");
    if (sitePlan.modsecurity?.enabled) {
      usesModsecurity = true;
      const ms = /** @type {Record<string, unknown>} */ (sitePlan.modsecurity);
      modsecurityProfiles.set(String(ms.profileId), ms);
    }
    if (sitePlan.block_common_exploits) blockCommonExploits = true;
    if (sitePlan.rate_limit) {
      const rl = /** @type {Record<string, unknown>} */ (sitePlan.rate_limit);
      rateLimitZones.set(String(rl.zoneName), rl);
    }

    const locations = Array.isArray(site.locations) ? site.locations.filter(isObject) : [];
    const locs = locations.length ? locations : [{ path: "/" }];
    for (let i = 0; i < locs.length; i++) {
      const locPlan = resolveLocationPolicyPlan(site, locs[i], i, catalog, sitePlan);
      if (locPlan.modsecurity?.enabled) {
        usesModsecurity = true;
        const ms = /** @type {Record<string, unknown>} */ (locPlan.modsecurity);
        modsecurityProfiles.set(String(ms.profileId), ms);
      } else if (locPlan.modsecurity && locPlan.modsecurity.enabled === false) {
        usesModsecurity = true;
      }
      if (locPlan.rate_limit) {
        const rl = /** @type {Record<string, unknown>} */ (locPlan.rate_limit);
        rateLimitZones.set(String(rl.zoneName), rl);
      }
    }
  }

  // Also scan catalog-only rate zones referenced by id
  for (const site of sites) {
    for (const ref of [].concat(site.policies || [])) {
      if (typeof ref !== "string") continue;
      const def = catalog[ref];
      if (def?.type === "rate_limit") {
        const zoneName =
          typeof def.zone_name === "string" && def.zone_name.trim()
            ? def.zone_name.trim()
            : ref;
        rateLimitZones.set(zoneName, { ...def, zoneName });
      }
    }
  }

  if (rateLimitZones.size) {
    const names = [...rateLimitZones.keys()];
    if (new Set(names).size !== names.length) {
      throw new Error("duplicate rate_limit zone_name in deployment group");
    }
  }

  return {
    modsecurityProfiles: [...modsecurityProfiles.entries()].map(([profileId, config]) => ({
      profileId,
      ...config,
    })),
    rateLimitZones: [...rateLimitZones.values()],
    blockCommonExploits,
    usesModsecurity,
  };
}

/**
 * @param {ReturnType<typeof collectGroupPolicyPlan>} plan
 */
export function groupUsesModsecurity(plan) {
  return plan.usesModsecurity && plan.modsecurityProfiles.some((p) => p.enabled !== false);
}
