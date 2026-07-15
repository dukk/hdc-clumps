import { routeMatchKey } from "./workers-config.mjs";

/**
 * @typedef {object} RoutePlanItem
 * @property {"create" | "delete" | "unchanged"} action
 * @property {string} key
 * @property {string} [route_id]
 * @property {string} pattern
 * @property {string} zone_name
 * @property {string} script_name
 */

/**
 * @typedef {object} SecretPlanItem
 * @property {"put" | "unchanged"} action
 * @property {string} name
 * @property {string} vault_key
 */

/**
 * @param {import('./workers-config.mjs').ConfigWorkerRoute[]} desiredRoutes
 * @param {import('./workers-api.mjs').CfWorkerRoute[]} liveRoutes
 * @param {string} scriptName
 * @param {boolean} prune
 */
export function planRouteSync(desiredRoutes, liveRoutes, scriptName, prune) {
  /** @type {RoutePlanItem[]} */
  const items = [];

  for (const d of desiredRoutes) {
    const key = routeMatchKey(d, scriptName);
    const live = liveRoutes.find(
      (r) => r.pattern === d.pattern && r.script === scriptName
    );
    if (live) {
      items.push({
        action: "unchanged",
        key,
        route_id: live.id,
        pattern: d.pattern,
        zone_name: d.zone_name,
        script_name: scriptName,
      });
    } else {
      items.push({
        action: "create",
        key,
        pattern: d.pattern,
        zone_name: d.zone_name,
        script_name: scriptName,
      });
    }
  }

  if (prune) {
    const desiredPatterns = new Set(desiredRoutes.map((d) => d.pattern));
    for (const live of liveRoutes) {
      if (live.script !== scriptName) continue;
      if (!desiredPatterns.has(live.pattern)) {
        items.push({
          action: "delete",
          key: `delete|${live.id}`,
          route_id: live.id,
          pattern: live.pattern,
          zone_name: "",
          script_name: scriptName,
        });
      }
    }
  }

  const summary = {
    create: items.filter((i) => i.action === "create").length,
    delete: items.filter((i) => i.action === "delete").length,
    unchanged: items.filter((i) => i.action === "unchanged").length,
  };

  return { items, summary };
}

/**
 * @param {import('./workers-config.mjs').ConfigWorkerSecret[]} desiredSecrets
 * @param {import('./workers-api.mjs').CfWorkerSecret[]} liveSecrets
 */
export function planSecretSync(desiredSecrets, liveSecrets) {
  const liveNames = new Set(liveSecrets.map((s) => s.name));

  /** @type {SecretPlanItem[]} */
  const items = desiredSecrets.map((d) => ({
    action: liveNames.has(d.name) ? "unchanged" : "put",
    name: d.name,
    vault_key: d.vault_key,
  }));

  // Always put when vault may have rotated values — treat as put unless dry-run only lists
  for (const item of items) {
    if (item.action === "unchanged") item.action = "put";
  }

  const summary = {
    put: items.filter((i) => i.action === "put").length,
    unchanged: 0,
  };

  return { items, summary };
}

/**
 * @param {import('./workers-api.mjs').ReturnType<import('./workers-api.mjs').createCloudflareWorkersClient>} api
 * @param {string} zoneId
 * @param {ReturnType<typeof planRouteSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyRouteSync(api, zoneId, plan, opts = {}) {
  const log = opts.log ?? (() => {});
  /** @type {{ action: string; key: string; ok: boolean; error?: string }[]} */
  const results = [];

  for (const item of plan.items) {
    if (item.action === "unchanged") {
      results.push({ action: item.action, key: item.key, ok: true });
      continue;
    }
    if (opts.dryRun) {
      log(`dry-run: route ${item.action} ${item.pattern}`);
      results.push({ action: item.action, key: item.key, ok: true });
      continue;
    }
    try {
      if (item.action === "create") {
        await api.createWorkerRoute(zoneId, {
          pattern: item.pattern,
          script: item.script_name,
        });
        results.push({ action: item.action, key: item.key, ok: true });
      } else if (item.action === "delete" && item.route_id) {
        await api.deleteWorkerRoute(zoneId, item.route_id);
        results.push({ action: item.action, key: item.key, ok: true });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ action: item.action, key: item.key, ok: false, error: msg });
    }
  }

  return { ok: results.every((r) => r.ok), results };
}

/**
 * @param {import('./workers-api.mjs').ReturnType<import('./workers-api.mjs').createCloudflareWorkersClient>} api
 * @param {string} scriptName
 * @param {ReturnType<typeof planSecretSync>} plan
 * @param {Record<string, string>} vaultSecrets
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applySecretSync(api, scriptName, plan, vaultSecrets, opts = {}) {
  const log = opts.log ?? (() => {});
  /** @type {{ action: string; name: string; ok: boolean; error?: string }[]} */
  const results = [];

  for (const item of plan.items) {
    if (item.action !== "put") {
      results.push({ action: item.action, name: item.name, ok: true });
      continue;
    }
    const value = vaultSecrets[item.vault_key];
    if (typeof value !== "string" || !value.trim()) {
      results.push({
        action: item.action,
        name: item.name,
        ok: false,
        error: `vault key missing or empty: ${item.vault_key}`,
      });
      continue;
    }
    if (opts.dryRun) {
      log(`dry-run: secret put ${item.name} (from ${item.vault_key})`);
      results.push({ action: item.action, name: item.name, ok: true });
      continue;
    }
    try {
      await api.putWorkerSecret(scriptName, { name: item.name, text: value.trim() });
      results.push({ action: item.action, name: item.name, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ action: item.action, name: item.name, ok: false, error: msg });
    }
  }

  return { ok: results.every((r) => r.ok), results };
}
