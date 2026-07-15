import {
  appsNeedUpdate,
  configAppToDesired,
  liveAppToNormalized,
  normalizedToGraphBody,
  patchBodyForDrift,
} from "./azure-config.mjs";

/**
 * @typedef {import('./azure-config.mjs').ConfigApplication} ConfigApplication
 * @typedef {import('./azure-graph-api.mjs').GraphApplication} GraphApplication
 */

/**
 * @param {object} opts
 * @param {ConfigApplication} opts.configApp
 * @param {GraphApplication | null} opts.live
 */
export function planAppSync(opts) {
  const { configApp, live } = opts;
  const desired = configAppToDesired(configApp);

  if (!live) {
    return {
      action: /** @type {"create"} */ ("create"),
      configId: configApp.id,
      desired,
      patch: null,
      unchanged: false,
    };
  }

  const liveNorm = liveAppToNormalized(live);
  if (!appsNeedUpdate(desired, liveNorm)) {
    return {
      action: /** @type {"unchanged"} */ ("unchanged"),
      configId: configApp.id,
      desired,
      live: liveNorm,
      patch: null,
      unchanged: true,
    };
  }

  const patch = patchBodyForDrift(desired, liveNorm);
  return {
    action: /** @type {"update"} */ ("update"),
    configId: configApp.id,
    desired,
    live: liveNorm,
    objectId: live.id,
    patch,
    unchanged: false,
  };
}

/**
 * @param {ReturnType<import('./azure-graph-api.mjs').createAzureGraphClient>} api
 * @param {ReturnType<typeof planAppSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void; ensureServicePrincipal?: boolean }} [opts]
 */
export async function applyAppSync(api, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});
  const ensureSp = opts.ensureServicePrincipal !== false;

  if (plan.action === "unchanged") {
    log(`unchanged ${plan.configId}`);
    return { ok: true, action: "unchanged", configId: plan.configId, clientId: plan.live?.client_id };
  }

  if (plan.action === "create") {
    const label = plan.configId;
    try {
      if (dryRun) {
        log(`dry-run: would create application ${label}`);
        return { ok: true, action: "create", configId: plan.configId, dryRun: true };
      }
      const body = normalizedToGraphBody(plan.desired);
      const created = await api.createApplication(body);
      log(`created ${label} (client_id=${created.appId})`);
      if (ensureSp && created.appId) {
        await api.ensureServicePrincipal(created.appId);
        log(`service principal ensured for ${created.appId}`);
      }
      return {
        ok: true,
        action: "create",
        configId: plan.configId,
        clientId: created.appId,
        objectId: created.id,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed create ${label}: ${msg}`);
      return { ok: false, action: "create", configId: plan.configId, error: msg };
    }
  }

  if (plan.action === "update" && plan.objectId && plan.patch) {
    const label = plan.configId;
    try {
      if (dryRun) {
        log(`dry-run: would update application ${label}`);
        return { ok: true, action: "update", configId: plan.configId, dryRun: true };
      }
      await api.patchApplication(plan.objectId, plan.patch);
      log(`updated ${label}`);
      if (ensureSp && plan.live?.client_id) {
        await api.ensureServicePrincipal(plan.live.client_id);
      }
      return {
        ok: true,
        action: "update",
        configId: plan.configId,
        clientId: plan.live?.client_id,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed update ${label}: ${msg}`);
      return { ok: false, action: "update", configId: plan.configId, error: msg };
    }
  }

  return { ok: false, action: plan.action, configId: plan.configId, error: "invalid plan" };
}
