import { createAzureGraphClient } from "./azure-graph-api.mjs";
import {
  applicationPassesFilter,
  appsNeedUpdate,
  configAppToDesired,
  findConfigForLiveApp,
  liveAppToNormalized,
  suggestedConfigEntry,
} from "./azure-config.mjs";
import { planAppSync } from "./azure-sync.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<import('./azure-config.mjs').normalizeAzureConfig>} opts.config
 * @param {ReturnType<typeof createAzureGraphClient>} opts.api
 * @param {string | undefined} [opts.appFilterId]
 */
export async function collectAzureState(opts) {
  const { config, api, appFilterId } = opts;
  const onlyApp = appFilterId ? config.applicationsById.get(appFilterId) : null;
  if (appFilterId && !onlyApp) {
    throw new Error(`Application not in config applications[]: ${appFilterId}`);
  }

  const allApps = await api.listApplications();
  const filteredLive = allApps.filter((a) =>
    applicationPassesFilter(a.displayName, config.applicationFilter)
  );

  /** @type {Map<string, import('./azure-graph-api.mjs').GraphApplication>} */
  const liveByClientId = new Map();
  /** @type {Map<string, import('./azure-graph-api.mjs').GraphApplication>} */
  const liveByDisplayLower = new Map();
  for (const app of filteredLive) {
    if (app.appId) liveByClientId.set(app.appId, app);
    const key = app.displayName.trim().toLowerCase();
    if (key && !liveByDisplayLower.has(key)) liveByDisplayLower.set(key, app);
  }

  /**
   * @param {import('./azure-config.mjs').ConfigApplication} cfgApp
   * @returns {import('./azure-graph-api.mjs').GraphApplication | null}
   */
  function findLiveForConfig(cfgApp) {
    if (cfgApp.match.client_id && liveByClientId.has(cfgApp.match.client_id)) {
      return liveByClientId.get(cfgApp.match.client_id) ?? null;
    }
    const name = (cfgApp.match.display_name ?? cfgApp.display_name).trim().toLowerCase();
    return name ? (liveByDisplayLower.get(name) ?? null) : null;
  }

  /** @type {object[]} */
  const discovered_applications = [];
  /** @type {object[]} */
  const managed_applications = [];
  /** @type {object[]} */
  const unmanaged_applications = [];
  /** @type {object[]} */
  const configured_missing = [];

  const configAppsToScan = onlyApp ? [onlyApp] : config.applications;

  for (const live of filteredLive) {
    const norm = liveAppToNormalized(live);
    const cfg = findConfigForLiveApp(norm, config.applications);
    const entry = {
      client_id: norm.client_id,
      object_id: norm.object_id,
      display_name: norm.display_name,
      sign_in_audience: norm.sign_in_audience,
      web_redirect_uris: norm.web.redirect_uris,
      spa_redirect_uris: norm.spa.redirect_uris,
      public_client_redirect_uris: norm.public_client.redirect_uris,
      required_resource_access_count: norm.required_resource_access.length,
      config_id: cfg?.id ?? null,
      managed: Boolean(cfg?.managed),
      suggested_config_entry: suggestedConfigEntry(norm, cfg?.id),
    };

    discovered_applications.push(entry);

    if (!cfg) {
      unmanaged_applications.push({
        client_id: norm.client_id,
        display_name: norm.display_name,
        object_id: norm.object_id,
      });
    } else if (cfg.managed) {
      const liveGraph = findLiveForConfig(cfg);
      const plan = planAppSync({ configApp: cfg, live: liveGraph });
      managed_applications.push({
        config_id: cfg.id,
        client_id: norm.client_id,
        display_name: norm.display_name,
        drift: plan.action === "update",
        action: plan.action,
      });
    }
  }

  for (const cfgApp of configAppsToScan) {
    if (!cfgApp.managed) continue;
    const live = findLiveForConfig(cfgApp);
    if (!live) {
      configured_missing.push({
        config_id: cfgApp.id,
        display_name: cfgApp.display_name,
        match: cfgApp.match,
      });
      continue;
    }
    const desired = configAppToDesired(cfgApp);
    const liveNorm = liveAppToNormalized(live);
    if (appsNeedUpdate(desired, liveNorm)) {
      const existing = managed_applications.find((m) => m.config_id === cfgApp.id);
      if (existing) {
        existing.drift = true;
        existing.action = "update";
      }
    }
  }

  return {
    tenant_application_count: allApps.length,
    filtered_application_count: filteredLive.length,
    discovered_applications,
    managed_applications,
    unmanaged_applications,
    configured_missing,
    managed_count: config.managedApplications.length,
  };
}

/** @deprecated Use collectAzureState */
export const collectAzureEntraState = collectAzureState;
