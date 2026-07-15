import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { normalizeBindConfig } from "../../bind/lib/deployments.mjs";
import { widgetBlockEnabled } from "./homepage-widget-utils.mjs";

/**
 * @typedef {{ rel: string; json: Record<string, unknown> }} HomepageBindStatsFile
 */

/**
 * @param {import("../../bind/lib/deployments.mjs").BindZoneDefinition[]} zones
 */
export function countBindZones(zones) {
  let zonesForward = 0;
  let zonesReverse = 0;
  for (const zone of zones) {
    if (zone.zone_type === "forward") zonesForward += 1;
    else if (zone.zone_type === "reverse") zonesReverse += 1;
  }
  return {
    zones_total: zones.length,
    zones_forward: zonesForward,
    zones_reverse: zonesReverse,
  };
}

/**
 * @param {Record<string, unknown>} bindCfg
 * @returns {HomepageBindStatsFile[]}
 */
export function buildBindWidgetStatsFiles(bindCfg) {
  const { zones } = normalizeBindConfig(bindCfg);
  const counts = countBindZones(zones);
  return [
    {
      rel: "stats/bind-a.json",
      json: { ...counts, role: "primary" },
    },
    {
      rel: "stats/bind-b.json",
      json: { ...counts, role: "secondary" },
    },
  ];
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function bindWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "bind_widget");
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.bindPackageRoot
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageBindWidgetEnv(opts) {
  const { homepage, bindPackageRoot, dryRun = false } = opts;
  if (!bindWidgetEnabled(homepage)) return null;

  errout.write("[hdc] homepage: resolving BIND widget stats from bind config …\n");

  const loaded = loadClumpConfigFromClumpRoot(bindPackageRoot, {
    exampleRel: "clumps/services/bind/config.example.json",
  });
  const statsFiles = buildBindWidgetStatsFiles(loaded.data);

  if (dryRun) {
    return {
      lines: [`# dry-run: would write ${statsFiles.length} BIND stats file(s) for customapi widgets`],
      statsFiles,
      zones_total: statsFiles[0]?.json.zones_total,
    };
  }

  errout.write(
    `[hdc] homepage: BIND widget stats ready (${statsFiles[0]?.json.zones_total ?? 0} zone(s), ${statsFiles.length} file(s)).\n`,
  );

  return {
    lines: [],
    statsFiles,
    zones_total: statsFiles[0]?.json.zones_total,
  };
}
