import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import {
  applicationPassesFilter,
  findConfigForLiveApp,
  liveAppToConfigEntry,
  liveAppToNormalized,
} from "./azure-config.mjs";
import { writeAzureConfig } from "./azure-config-write.mjs";
import { CLUMP_CONFIG_EXAMPLE } from "./azure-run-context.mjs";
import { resolveAzureClientId } from "./vault-deps.mjs";

export const AZURE_COMPACT_ARRAY_KEYS = ["applications"];

/**
 * @param {import('./azure-graph-api.mjs').GraphApplication[]} liveApps
 * @param {{ mode: string; prefixes: string[] }} applicationFilter
 * @param {string} [automationClientId]
 * @param {import('./azure-config.mjs').ConfigApplication[] | Record<string, unknown>[]} [existingApplications]
 */
export function liveAppsToConfigEntries(
  liveApps,
  applicationFilter,
  automationClientId,
  existingApplications = []
) {
  const automationId = automationClientId?.trim().toLowerCase() ?? "";
  const filtered = liveApps.filter((a) => applicationPassesFilter(a.displayName, applicationFilter));
  const skipAutomation = filtered.filter(
    (a) => !automationId || String(a.appId ?? "").trim().toLowerCase() !== automationId
  );

  /** @type {import('./azure-config.mjs').ConfigApplication[]} */
  const existing = Array.isArray(existingApplications)
    ? /** @type {import('./azure-config.mjs').ConfigApplication[]} */ (existingApplications)
    : [];
  /** @type {Set<import('./azure-config.mjs').ConfigApplication>} */
  const usedExisting = new Set();

  /** @type {Set<string>} */
  const usedIds = new Set();
  /** @type {Record<string, unknown>[]} */
  const applications = [];

  for (const live of skipAutomation) {
    const norm = liveAppToNormalized(live);
    const remaining = existing.filter((e) => !usedExisting.has(e));
    const matched = findConfigForLiveApp(norm, remaining);
    if (matched) usedExisting.add(matched);

    const entry = liveAppToConfigEntry(norm, matched);

    let id = entry.id;
    if (usedIds.has(id)) {
      id = `${id}-${norm.client_id.slice(0, 8)}`;
      entry.id = id;
    }
    usedIds.add(id);

    applications.push(entry);
  }

  applications.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return applications;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {import('./azure-graph-api.mjs').GraphApplication[]} opts.liveApps
 * @param {{ mode: string; prefixes: string[] }} opts.applicationFilter
 * @param {(line: string) => void} [opts.log]
 */
export function importAzureToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });

  let automationClientId = "";
  try {
    const automation =
      cfgRaw.entra && typeof cfgRaw.entra === "object"
        ? /** @type {Record<string, unknown>} */ (cfgRaw.entra).automation
        : undefined;
    automationClientId = resolveAzureClientId({
      automation:
        automation && typeof automation === "object"
          ? /** @type {import('./vault-deps.mjs').EntraAutomationCreds} */ (automation)
          : undefined,
    });
  } catch {
    automationClientId = "";
  }

  const existingEntra = cfgRaw.entra && typeof cfgRaw.entra === "object" ? cfgRaw.entra : null;
  const existingApps = Array.isArray(existingEntra?.applications)
    ? existingEntra.applications
    : Array.isArray(cfgRaw.applications)
      ? cfgRaw.applications
      : [];

  const applications = liveAppsToConfigEntries(
    opts.liveApps,
    opts.applicationFilter,
    automationClientId,
    existingApps
  );

  const graphBase =
    (existingEntra &&
      typeof existingEntra.graph_base_url === "string" &&
      existingEntra.graph_base_url.trim()) ||
    (cfgRaw.azure &&
      typeof cfgRaw.azure === "object" &&
      typeof cfgRaw.azure.graph_base_url === "string" &&
      cfgRaw.azure.graph_base_url.trim()) ||
    (cfgRaw.azure_entra &&
      typeof cfgRaw.azure_entra === "object" &&
      typeof cfgRaw.azure_entra.graph_base_url === "string" &&
      cfgRaw.azure_entra.graph_base_url.trim()) ||
    "https://graph.microsoft.com/v1.0";

  const filterRaw =
    (existingEntra && existingEntra.application_filter) ||
    (cfgRaw.application_filter && typeof cfgRaw.application_filter === "object"
      ? cfgRaw.application_filter
      : { mode: "all", display_name_prefixes: [] });

  const compute =
    cfgRaw.compute && typeof cfgRaw.compute === "object"
      ? cfgRaw.compute
      : undefined;

  const next = {
    ...cfgRaw,
    schema_version: 2,
    entra: {
      graph_base_url: String(graphBase).replace(/\/$/, ""),
      application_filter: filterRaw,
      applications,
    },
  };
  if (compute) next.compute = compute;
  delete next.applications;
  delete next.application_filter;
  delete next.azure;
  delete next.azure_entra;
  delete next.defaults;
  delete next.deployments;

  const written = writeAzureConfig(resolved, next, {
    compactArrayKeys: AZURE_COMPACT_ARRAY_KEYS,
    split: true,
  });
  log(
    `Wrote ${applications.length} application(s) to config (${source}: ${resolved.rel}, layout=${written.layout}).`
  );

  return {
    application_count: applications.length,
    configPath: resolved.path,
    configRel: resolved.rel,
    source,
    layout: written.layout,
  };
}
