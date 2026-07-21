#!/usr/bin/env node
/**
 * Cloudflare query: zones, DNS, page rules, email routing, domain portfolio (JSON on stdout).
 *
 * Usage: hdc run infrastructure cloudflare query --
 *   [--zone <name>] [--import-zones] [--import-page-rules] [--import-email-routing]
 *   [--export-inventory] [--skip-domain-expiry] [--yes]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createCloudflareClient } from "hdc/package/cloudflare-api.mjs";
import { normalizeCloudflareConfig, zonePassesFilter } from "hdc/package/cloudflare-config.mjs";
import {
  buildDiscoveredZones,
  collectCloudflareDnsState,
  fetchLiveZonesWithRecords,
} from "hdc/package/cloudflare-collect.mjs";
import {
  importEmailRoutingToConfig,
  importPageRulesToConfig,
  importZonesToConfig,
} from "hdc/package/cloudflare-import.mjs";
import { createCloudflareDomainRegistrar } from "hdc/package/cloudflare-domain-registrar.mjs";
import { writeAutomatedDomainInventory } from "hdc/package/domain-registrar.mjs";
import { createCloudflareVaultAccess, resolveCloudflareToken } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/cloudflare/config.example.json";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[cloudflare] ${line}\n`);
}

/**
 * @param {string} question
 */
async function confirm(question) {
  const rl = createInterface({ input, output: errout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

async function main() {
  log(`${verb}: starting`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const zoneName = flagGet(flags, "zone");
  const importZones = flags["import-zones"] === "1";
  const importPageRules = flags["import-page-rules"] === "1";
  const importEmailRouting = flags["import-email-routing"] === "1";
  const exportInventory = flags["export-inventory"] === "1";
  const skipDomainExpiry = flags["skip-domain-expiry"] === "1";
  const yes = flags.yes === "1";
  const bootstrapFromExample = importZones || importPageRules || importEmailRouting;

  if (importZones) {
    log("import-zones: will replace zones[] in config.json with live DNS snapshot from Cloudflare.");
  }
  if (importPageRules) {
    log("import-page-rules: will merge page_rules[] on matching config zones from live API.");
  }
  if (importEmailRouting) {
    log("import-email-routing: will merge email_routing_rules[] and catch_all on matching config zones.");
  }
  if (exportInventory) {
    log("export-inventory: will write operations/automated/domains/*.json from live zones + RDAP.");
  }

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    bootstrapFromExample,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  let config = normalizeCloudflareConfig(cfgRaw);
  const vault = createCloudflareVaultAccess();
  const token = await resolveCloudflareToken(vault);
  log("API token loaded");

  const api = createCloudflareClient({
    token,
    baseUrl: config.apiBase,
    accountId: config.accountId,
  });

  const needsLiveRecords =
    importZones || importPageRules || importEmailRouting || !exportInventory;
  /** @type {{ liveZones: Awaited<ReturnType<typeof fetchLiveZonesWithRecords>>["liveZones"] }} */
  let liveFetch = { liveZones: [] };
  /** @type {ReturnType<typeof buildDiscoveredZones>} */
  let discoveredZones = [];

  if (needsLiveRecords) {
    log("fetching zones, DNS, page rules, and email routing from Cloudflare API");
    liveFetch = await fetchLiveZonesWithRecords({
      config,
      api,
      zoneFilterName: zoneName,
    });
    discoveredZones = buildDiscoveredZones(liveFetch.liveZones);
  } else {
    log("export-inventory: skipping full DNS/page-rule/email scan (zones + RDAP only)");
  }

  /** @type {{ zone_count: number; record_count: number; config_rel: string } | null} */
  let importZonesResult = null;
  /** @type {{ zones_updated: number; config_rel: string } | null} */
  let importPageRulesResult = null;
  /** @type {{ zones_updated: number; config_rel: string } | null} */
  let importEmailRoutingResult = null;

  if (importZones) {
    const zoneCount = liveFetch.liveZones.length;
    const recordCount = liveFetch.liveZones.reduce((n, z) => n + z.records.length, 0);
    if (!yes) {
      const ok = await confirm(
        `Replace zones[] with ${zoneCount} zone(s) (${recordCount} DNS record(s))? [y/N] `
      );
      if (!ok) {
        errout.write("[cloudflare] Aborted: import not confirmed (use --yes to skip prompt).\n");
        process.exitCode = 1;
        return;
      }
    }
    const written = importZonesToConfig({
      clumpRoot,
      liveZones: liveFetch.liveZones,
      log,
    });
    importZonesResult = {
      zone_count: written.zones.length,
      record_count: written.recordCount,
      config_rel: written.configRel,
    };
    config = normalizeCloudflareConfig({ ...cfgRaw, zones: written.zones });
    log(`import-zones complete: ${written.configRel}`);
  }

  if (importPageRules) {
    const configured = liveFetch.liveZones.filter((z) => config.zonesByName.has(z.name));
    if (!yes) {
      const ok = await confirm(
        `Merge page_rules on ${configured.length} configured zone(s)? [y/N] `
      );
      if (!ok) {
        errout.write("[cloudflare] Aborted: import-page-rules not confirmed (use --yes).\n");
        process.exitCode = 1;
        return;
      }
    }
    importPageRulesResult = importPageRulesToConfig({
      clumpRoot,
      liveByZone: configured.map((z) => ({ name: z.name, page_rules: z.page_rules })),
      log,
    });
    log(`import-page-rules complete: ${importPageRulesResult.config_rel}`);
  }

  if (importEmailRouting) {
    const configured = liveFetch.liveZones.filter((z) => config.zonesByName.has(z.name));
    if (!yes) {
      const ok = await confirm(
        `Merge email routing on ${configured.length} configured zone(s)? [y/N] `
      );
      if (!ok) {
        errout.write("[cloudflare] Aborted: import-email-routing not confirmed (use --yes).\n");
        process.exitCode = 1;
        return;
      }
    }
    importEmailRoutingResult = importEmailRoutingToConfig({
      clumpRoot,
      liveByZone: configured.map((z) => ({
        name: z.name,
        email_routing_rules: z.email_routing_rules,
        catch_all: z.catch_all,
      })),
      log,
    });
    log(`import-email-routing complete: ${importEmailRoutingResult.config_rel}`);
  }

  /** @type {Awaited<ReturnType<typeof collectCloudflareDnsState>> | null} */
  let state = null;
  if (needsLiveRecords) {
    state = await collectCloudflareDnsState({
      config,
      api,
      zoneFilterName: zoneName,
    });
  } else {
    const allZones = await api.listZones();
    const filtered = allZones.filter((z) => zonePassesFilter(z.name, config.zoneFilter));
    const configuredNames = new Set(config.zones.map((z) => z.name));
    const accountNames = new Set(filtered.map((z) => z.name));
    discoveredZones = buildDiscoveredZones(
      filtered.map((z) => ({
        name: z.name,
        zone_id: z.id,
        status: z.status,
        records: [],
        page_rules: [],
        email_routing_rules: [],
        catch_all: null,
      }))
    );
    state = {
      account_zones: filtered
        .filter((z) => configuredNames.has(z.name))
        .map((z) => ({ name: z.name, zone_id: z.id, status: z.status })),
      unmanaged_zones: filtered
        .filter((z) => !configuredNames.has(z.name))
        .map((z) => ({ name: z.name, zone_id: z.id, status: z.status })),
      missing_configured_zones: [...configuredNames].filter((n) => !accountNames.has(n)),
      zones_scanned: filtered.map((z) => z.name),
    };
  }

  const registrar = createCloudflareDomainRegistrar({
    api,
    config,
    fetchExpiry: !skipDomainExpiry,
  });
  log(
    skipDomainExpiry
      ? "listing domains (zones only; skipping RDAP expiry)"
      : "listing domains (zones + RDAP expiry)"
  );
  const domainRecords = await registrar.listDomains({
    info: (s) => log(s),
  });

  /** @type {{ written: number; paths: string[] } | null} */
  let exportInventoryResult = null;
  if (exportInventory) {
    if (!yes) {
      const ok = await confirm(
        `Write ${domainRecords.length} automated domain sidecar(s) under operations/automated/domains/? [y/N] `
      );
      if (!ok) {
        errout.write("[cloudflare] Aborted: export-inventory not confirmed (use --yes).\n");
        process.exitCode = 1;
        return;
      }
    }
    exportInventoryResult = writeAutomatedDomainInventory(repoRoot(), domainRecords, {
      backendId: "cloudflare",
      log: { info: (s) => log(s) },
    });
    log(`export-inventory complete: ${exportInventoryResult.written} file(s)`);
  }

  const domainsSummary = domainRecords.map((d) => ({
    apex: d.apex,
    in_account: d.in_account,
    status: d.status ?? null,
    zone_id: d.zone_id ?? null,
    expires_at: d.expires_at ?? null,
    registrar_name: d.registrar_name ?? null,
  }));

  const payload = {
    ok: state.missing_configured_zones.length === 0,
    verb: "query",
    package: "cloudflare",
    config_source: source,
    zone_filter: config.zoneFilter,
    managed_zone_names: config.zones.map((z) => z.name),
    discovered_zones: discoveredZones,
    account_zones: state.account_zones,
    unmanaged_zones: state.unmanaged_zones,
    missing_configured_zones: state.missing_configured_zones,
    zones_scanned: state.zones_scanned,
    domains: domainsSummary,
    import_zones: importZonesResult,
    import_page_rules: importPageRulesResult,
    import_email_routing: importEmailRoutingResult,
    export_inventory: exportInventoryResult,
    collected_at: new Date().toISOString(),
    summary:
      "Cloudflare snapshot (DNS, page rules, email routing, domains). Use --import-* to bootstrap config; --export-inventory writes automated domain sidecars; maintain applies managed resources.",
  };

  if (state.missing_configured_zones.length) {
    log(
      `warning: configured zones not in account: ${state.missing_configured_zones.join(", ")}`
    );
  }
  log(
    `done: ${discoveredZones.length} zone(s) discovered, ${state.account_zones.length} managed, ${state.unmanaged_zones.length} unmanaged, ${domainsSummary.length} domain(s)`
  );

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (state.missing_configured_zones.length) process.exitCode = 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
