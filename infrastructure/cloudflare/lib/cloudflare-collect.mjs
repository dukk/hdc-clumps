import { createCloudflareClient } from "./cloudflare-api.mjs";
import {
  liveRecordToNormalized,
  normalizeZoneName,
  zonePassesFilter,
} from "./cloudflare-config.mjs";
import {
  importCatchAllFromLive,
  importEmailRoutingRulesFromLive,
  importPageRulesFromLive,
  normalizedRecordToConfigEntry,
} from "./cloudflare-import.mjs";
import { planZoneSync } from "./cloudflare-sync.mjs";
import { planPageRuleSync } from "./cloudflare-page-rules-sync.mjs";
import {
  planCatchAllSync,
  planEmailRoutingRuleSync,
} from "./cloudflare-email-routing-sync.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<import('./cloudflare-config.mjs').normalizeCloudflareConfig>} opts.config
 * @param {ReturnType<typeof createCloudflareClient>} opts.api
 * @param {string | undefined} [opts.zoneFilterName]
 * @param {boolean} [opts.includeRules]
 */
export async function fetchLiveZonesWithRecords(opts) {
  const { config, api, zoneFilterName, includeRules = true } = opts;
  const onlyZone = zoneFilterName ? normalizeZoneName(zoneFilterName) : null;

  const allZones = await api.listZones();
  const filtered = allZones.filter((z) => zonePassesFilter(z.name, config.zoneFilter));
  const zonesToFetch = onlyZone ? filtered.filter((z) => z.name === onlyZone) : filtered;

  if (onlyZone && zonesToFetch.length === 0) {
    const inAccount = allZones.some((z) => z.name === onlyZone);
    if (!inAccount) {
      throw new Error(`Zone not found in Cloudflare account: ${onlyZone}`);
    }
    throw new Error(`Zone excluded by cloudflare.zone_filter: ${onlyZone}`);
  }

  /** @type {{ name: string; zone_id: string; status?: string; records: import('./cloudflare-config.mjs').NormalizedRecord[]; page_rules: import('./cloudflare-api.mjs').CfPageRule[]; email_routing_rules: import('./cloudflare-api.mjs').CfEmailRoutingRule[]; catch_all: import('./cloudflare-api.mjs').CfEmailRoutingCatchAll | null }[]} */
  const liveZones = [];

  for (const zone of zonesToFetch) {
    const live = await api.listDnsRecords(zone.id);
    const records = live.map((r) => liveRecordToNormalized(r, zone.name));
    /** @type {import('./cloudflare-api.mjs').CfPageRule[]} */
    let page_rules = [];
    /** @type {import('./cloudflare-api.mjs').CfEmailRoutingRule[]} */
    let email_routing_rules = [];
    /** @type {import('./cloudflare-api.mjs').CfEmailRoutingCatchAll | null} */
    let catch_all = null;

    if (includeRules) {
      try {
        page_rules = await api.listPageRules(zone.id);
      } catch {
        page_rules = [];
      }
      try {
        email_routing_rules = await api.listEmailRoutingRules(zone.id);
      } catch {
        email_routing_rules = [];
      }
      try {
        catch_all = await api.getEmailRoutingCatchAll(zone.id);
      } catch {
        catch_all = null;
      }
    }

    liveZones.push({
      name: zone.name,
      zone_id: zone.id,
      status: zone.status,
      records,
      page_rules,
      email_routing_rules,
      catch_all,
    });
  }

  return { liveZones, zones_fetched: zonesToFetch.length, all_zone_count: allZones.length };
}

/**
 * @param {{ name: string; zone_id: string; status?: string; records: import('./cloudflare-config.mjs').NormalizedRecord[]; page_rules?: import('./cloudflare-api.mjs').CfPageRule[]; email_routing_rules?: import('./cloudflare-api.mjs').CfEmailRoutingRule[]; catch_all?: import('./cloudflare-api.mjs').CfEmailRoutingCatchAll | null }[]} liveZones
 */
export function buildDiscoveredZones(liveZones) {
  return liveZones.map((z) => {
    const configRecords = z.records.map((r) => normalizedRecordToConfigEntry(r));
    const pageRules = importPageRulesFromLive(z.page_rules ?? []);
    const emailRules = importEmailRoutingRulesFromLive(z.email_routing_rules ?? []);
    const catchAll = importCatchAllFromLive(z.catch_all ?? null);
    /** @type {Record<string, unknown>} */
    const suggested = {
      name: z.name,
      records: configRecords,
    };
    if (pageRules.length) suggested.page_rules = pageRules;
    if (emailRules.length) suggested.email_routing_rules = emailRules;
    if (catchAll) suggested.email_routing = { catch_all: catchAll };

    return {
      name: z.name,
      zone_id: z.zone_id,
      status: z.status,
      record_count: z.records.length,
      page_rule_count: (z.page_rules ?? []).length,
      email_routing_rule_count: (z.email_routing_rules ?? []).length,
      has_catch_all: Boolean(catchAll),
      records: configRecords,
      page_rules: pageRules,
      email_routing_rules: emailRules,
      catch_all: catchAll,
      suggested_zone_config: suggested,
    };
  });
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./cloudflare-config.mjs').normalizeCloudflareConfig>} opts.config
 * @param {ReturnType<typeof createCloudflareClient>} opts.api
 * @param {string | undefined} [opts.zoneFilterName]
 */
export async function collectCloudflareDnsState(opts) {
  const { config, api, zoneFilterName } = opts;
  const onlyZone = zoneFilterName ? normalizeZoneName(zoneFilterName) : null;

  const allZones = await api.listZones();
  const filtered = allZones.filter((z) => zonePassesFilter(z.name, config.zoneFilter));
  const zonesToScan = onlyZone ? filtered.filter((z) => z.name === onlyZone) : filtered;

  if (onlyZone && zonesToScan.length === 0) {
    const inAccount = allZones.some((z) => z.name === onlyZone);
    if (!inAccount) {
      throw new Error(`Zone not found in Cloudflare account: ${onlyZone}`);
    }
    throw new Error(`Zone excluded by cloudflare.zone_filter: ${onlyZone}`);
  }

  /** @type {object[]} */
  const accountZones = [];
  /** @type {object[]} */
  const unmanagedZones = [];

  for (const zone of zonesToScan) {
    const live = await api.listDnsRecords(zone.id);
    const configZone = config.zonesByName.get(zone.name);
    const managed = Boolean(configZone);

    /** @type {import('./cloudflare-api.mjs').CfPageRule[]} */
    let livePageRules = [];
    /** @type {import('./cloudflare-api.mjs').CfEmailRoutingRule[]} */
    let liveEmailRules = [];
    /** @type {import('./cloudflare-api.mjs').CfEmailRoutingCatchAll | null} */
    let liveCatchAll = null;

    try {
      livePageRules = await api.listPageRules(zone.id);
    } catch {
      livePageRules = [];
    }
    try {
      liveEmailRules = await api.listEmailRoutingRules(zone.id);
    } catch {
      liveEmailRules = [];
    }
    try {
      liveCatchAll = await api.getEmailRoutingCatchAll(zone.id);
    } catch {
      liveCatchAll = null;
    }

    if (!managed) {
      unmanagedZones.push({
        name: zone.name,
        zone_id: zone.id,
        status: zone.status,
        record_count: live.length,
        page_rule_count: livePageRules.length,
        email_routing_rule_count: liveEmailRules.length,
      });
      continue;
    }

    const dnsPlan = planZoneSync({
      desired: configZone.records,
      live,
      zoneName: zone.name,
      prune: false,
    });

    /** @type {object | null} */
    let page_rules_diff = null;
    if (configZone.manages_page_rules) {
      try {
        page_rules_diff = planPageRuleSync(configZone.page_rules ?? [], livePageRules, false).summary;
      } catch (e) {
        page_rules_diff = {
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    /** @type {object | null} */
    let email_routing_diff = null;
    if (configZone.manages_email_routing_rules) {
      try {
        email_routing_diff = planEmailRoutingRuleSync(
          configZone.email_routing_rules ?? [],
          liveEmailRules,
          false
        ).summary;
      } catch (e) {
        email_routing_diff = {
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    /** @type {object | null} */
    let catch_all_diff = null;
    if (configZone.manages_email_routing_catch_all && configZone.email_routing?.catch_all) {
      try {
        catch_all_diff = planCatchAllSync(
          configZone.email_routing.catch_all,
          liveCatchAll
        ).summary;
      } catch (e) {
        catch_all_diff = {
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    accountZones.push({
      name: zone.name,
      zone_id: zone.id,
      status: zone.status,
      managed: true,
      record_count: live.length,
      desired_count: configZone.records.length,
      page_rule_count: livePageRules.length,
      email_routing_rule_count: liveEmailRules.length,
      diff: dnsPlan.summary,
      page_rules_diff,
      email_routing_diff,
      catch_all_diff,
    });
  }

  /** @type {string[]} */
  const missingFromAccount = [];
  for (const cz of config.zones) {
    if (onlyZone && cz.name !== onlyZone) continue;
    const found = allZones.some((z) => z.name === cz.name);
    if (!found) missingFromAccount.push(cz.name);
  }

  return {
    account_zones: accountZones,
    unmanaged_zones: unmanagedZones,
    missing_configured_zones: missingFromAccount,
    zones_scanned: zonesToScan.length,
  };
}

export { importZonesFromLive } from "./cloudflare-import.mjs";
