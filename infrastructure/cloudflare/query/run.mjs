#!/usr/bin/env node
/**
 * Cloudflare query: zones, DNS, page rules, email routing (JSON on stdout).
 *
 * Usage: hdc run infrastructure cloudflare query --
 *   [--zone <name>] [--import-zones] [--import-page-rules] [--import-email-routing] [--yes]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createCloudflareClient } from "hdc/package/cloudflare-api.mjs";
import { normalizeCloudflareConfig } from "hdc/package/cloudflare-config.mjs";
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

  log("fetching zones, DNS, page rules, and email routing from Cloudflare API");
  const liveFetch = await fetchLiveZonesWithRecords({
    config,
    api,
    zoneFilterName: zoneName,
  });
  const discoveredZones = buildDiscoveredZones(liveFetch.liveZones);

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

  const state = await collectCloudflareDnsState({
    config,
    api,
    zoneFilterName: zoneName,
  });

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
    import_zones: importZonesResult,
    import_page_rules: importPageRulesResult,
    import_email_routing: importEmailRoutingResult,
    collected_at: new Date().toISOString(),
    summary:
      "Cloudflare snapshot (DNS, page rules, email routing). Use --import-zones, --import-page-rules, or --import-email-routing to bootstrap config; maintain applies managed resources.",
  };

  if (state.missing_configured_zones.length) {
    log(
      `warning: configured zones not in account: ${state.missing_configured_zones.join(", ")}`
    );
  }
  log(
    `done: ${discoveredZones.length} zone(s) discovered, ${state.account_zones.length} managed, ${state.unmanaged_zones.length} unmanaged in scan`
  );

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (state.missing_configured_zones.length) process.exitCode = 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
