import { createCloudflareClient } from "../../cloudflare/lib/cloudflare-api.mjs";
import { createCloudflareWorkersClient } from "./workers-api.mjs";
import { zonePassesFilter } from "./workers-config.mjs";

/**
 * @typedef {object} WorkerLiveState
 * @property {string} script_name
 * @property {boolean} exists
 * @property {{ zone_name: string; zone_id: string; routes: import('./workers-api.mjs').CfWorkerRoute[] }[]} routes_by_zone
 * @property {string[]} secret_names
 */

/**
 * @typedef {object} WorkersCollectSnapshot
 * @property {import('./workers-api.mjs').CfWorkerScript[]} live_scripts
 * @property {import('./workers-api.mjs').CfPagesProject[]} live_pages
 * @property {WorkerLiveState[]} workers
 * @property {string[]} missing_worker_scripts
 * @property {string[]} missing_pages_projects
 * @property {string[]} unmanaged_live_scripts
 * @property {string[]} unmanaged_live_pages
 */

/**
 * @param {import('./workers-config.mjs').NormalizedWorkersConfig} config
 * @param {string} token
 */
export function createWorkersCollectClients(config, token) {
  const workersApi = createCloudflareWorkersClient({
    token,
    accountId: config.accountId,
    baseUrl: config.apiBase,
  });
  const dnsApi = createCloudflareClient({
    token,
    baseUrl: config.apiBase,
    accountId: config.accountId,
  });
  return { workersApi, dnsApi };
}

/**
 * @param {import('./workers-config.mjs').NormalizedWorkersConfig} config
 * @param {ReturnType<typeof createCloudflareWorkersClient>} workersApi
 * @param {ReturnType<typeof createCloudflareClient>} dnsApi
 * @returns {Promise<WorkersCollectSnapshot>}
 */
export async function collectWorkersState(config, workersApi, dnsApi) {
  const liveScripts = await workersApi.listWorkerScripts();
  const livePages = await workersApi.listPagesProjects();
  const liveScriptNames = new Set(liveScripts.map((s) => s.name));
  const livePageNames = new Set(livePages.map((p) => p.name));

  const managedScriptNames = new Set(
    config.workers.filter((w) => w.managed).map((w) => w.script_name)
  );
  const managedPageNames = new Set(
    config.pages.filter((p) => p.managed).map((p) => p.project_name)
  );

  const zones = await dnsApi.listZones();
  const zoneByName = new Map(zones.map((z) => [z.name, z]));

  /** @type {WorkerLiveState[]} */
  const workerStates = [];

  for (const worker of config.workers.filter((w) => w.managed)) {
    const exists = liveScriptNames.has(worker.script_name);
    let secretNames = [];
    if (exists) {
      try {
        const secrets = await workersApi.listWorkerSecrets(worker.script_name);
        secretNames = secrets.map((s) => s.name).filter(Boolean);
      } catch {
        secretNames = [];
      }
    }

    /** @type {WorkerLiveState["routes_by_zone"]} */
    const routesByZone = [];
    const zoneNames = new Set(worker.routes.map((r) => r.zone_name));
    for (const zoneName of zoneNames) {
      if (!zonePassesFilter(zoneName, config.zoneFilter)) continue;
      const zone = zoneByName.get(zoneName);
      if (!zone) {
        routesByZone.push({ zone_name: zoneName, zone_id: "", routes: [] });
        continue;
      }
      const routes = await workersApi.listWorkerRoutes(zone.id);
      routesByZone.push({
        zone_name: zoneName,
        zone_id: zone.id,
        routes: routes.filter((r) => r.script === worker.script_name),
      });
    }

    workerStates.push({
      script_name: worker.script_name,
      exists,
      routes_by_zone: routesByZone,
      secret_names: secretNames,
    });
  }

  return buildSnapshotFromLive(config, liveScripts, livePages, liveScriptNames, livePageNames, workerStates, managedScriptNames, managedPageNames);
}

/**
 * @param {import('./workers-config.mjs').NormalizedWorkersConfig} config
 * @param {ReturnType<typeof createCloudflareWorkersClient>} workersApi
 * @param {ReturnType<typeof createCloudflareClient>} dnsApi
 */
export async function collectAllRoutesByScript(config, workersApi, dnsApi) {
  const zones = await dnsApi.listZones();
  /** @type {Map<string, { zone_name: string; zone_id: string; routes: import('./workers-api.mjs').CfWorkerRoute[] }[]>} */
  const byScript = new Map();

  for (const zone of zones) {
    if (!zonePassesFilter(zone.name, config.zoneFilter)) continue;
    const routes = await workersApi.listWorkerRoutes(zone.id);
    for (const route of routes) {
      if (!route.script) continue;
      let entries = byScript.get(route.script);
      if (!entries) {
        entries = [];
        byScript.set(route.script, entries);
      }
      let zoneEntry = entries.find((e) => e.zone_name === zone.name);
      if (!zoneEntry) {
        zoneEntry = { zone_name: zone.name, zone_id: zone.id, routes: [] };
        entries.push(zoneEntry);
      }
      zoneEntry.routes.push(route);
    }
  }

  return byScript;
}

/**
 * @param {import('./workers-config.mjs').NormalizedWorkersConfig} config
 * @param {import('./workers-api.mjs').CfWorkerScript[]} liveScripts
 * @param {import('./workers-api.mjs').CfPagesProject[]} livePages
 * @param {Set<string>} liveScriptNames
 * @param {Set<string>} livePageNames
 * @param {WorkerLiveState[]} workerStates
 * @param {Set<string>} managedScriptNames
 * @param {Set<string>} managedPageNames
 */
function buildSnapshotFromLive(
  config,
  liveScripts,
  livePages,
  liveScriptNames,
  livePageNames,
  workerStates,
  managedScriptNames,
  managedPageNames
) {
  return {
    live_scripts: liveScripts,
    live_pages: livePages,
    workers: workerStates,
    missing_worker_scripts: config.workers
      .filter((w) => w.managed && !liveScriptNames.has(w.script_name))
      .map((w) => w.script_name),
    missing_pages_projects: config.pages
      .filter((p) => p.managed && !livePageNames.has(p.project_name))
      .map((p) => p.project_name),
    unmanaged_live_scripts: liveScripts
      .map((s) => s.name)
      .filter((n) => !managedScriptNames.has(n)),
    unmanaged_live_pages: livePages
      .map((p) => p.name)
      .filter((n) => !managedPageNames.has(n)),
  };
}
