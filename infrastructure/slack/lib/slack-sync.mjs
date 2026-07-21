import {
  appsNeedUpdate,
  configAppToDesired,
  configAppToManifest,
  liveManifestToNormalized,
} from "./slack-config.mjs";

/**
 * @param {object} opts
 * @param {import('./slack-config.mjs').SlackConfigApp} opts.configApp
 * @param {{ app_id: string, manifest: Record<string, unknown> } | null} opts.live
 * @param {string} [opts.requestUrl]
 * @param {string} [opts.eventsRequestUrl]
 * @param {{ command: string, description: string, url: string }[]} [opts.slashCommands]
 */
export function planAppSync(opts) {
  const { configApp, live } = opts;
  const manifestOpts = {
    requestUrl: opts.requestUrl,
    eventsRequestUrl: opts.eventsRequestUrl,
    slashCommands: opts.slashCommands,
  };
  const desired = configAppToDesired(configApp, manifestOpts);

  if (!live || !live.app_id) {
    return {
      action: /** @type {"create"} */ ("create"),
      configId: configApp.id,
      desired,
      manifest: configAppToManifest(configApp, manifestOpts),
      patch: null,
      unchanged: false,
    };
  }

  const liveNorm = liveManifestToNormalized(live.manifest);
  if (!appsNeedUpdate(desired, liveNorm)) {
    return {
      action: /** @type {"unchanged"} */ ("unchanged"),
      configId: configApp.id,
      desired,
      live: liveNorm,
      appId: live.app_id,
      patch: null,
      unchanged: true,
    };
  }

  return {
    action: /** @type {"update"} */ ("update"),
    configId: configApp.id,
    desired,
    live: liveNorm,
    appId: live.app_id,
    manifest: configAppToManifest(configApp, manifestOpts),
    unchanged: false,
  };
}

/**
 * @param {ReturnType<import('./slack-api.mjs').createSlackManifestClient>} api
 * @param {ReturnType<typeof planAppSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyAppSync(api, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "unchanged") {
    log(`unchanged ${plan.configId}`);
    return { ok: true, action: "unchanged", configId: plan.configId, appId: plan.appId };
  }

  if (plan.action === "create") {
    try {
      if (dryRun) {
        log(`dry-run: would create Slack app ${plan.configId}`);
        return { ok: true, action: "create", configId: plan.configId, dryRun: true };
      }
      const created = await api.createApp(plan.manifest);
      const appId = typeof created.app_id === "string" ? created.app_id : "";
      const credentials =
        created.credentials && typeof created.credentials === "object"
          ? /** @type {Record<string, unknown>} */ (created.credentials)
          : {};
      log(`created ${plan.configId} (app_id=${appId})`);
      return {
        ok: true,
        action: "create",
        configId: plan.configId,
        appId,
        credentials: {
          client_id: typeof credentials.client_id === "string" ? credentials.client_id : "",
          client_secret:
            typeof credentials.client_secret === "string" ? credentials.client_secret : "",
          signing_secret:
            typeof credentials.signing_secret === "string" ? credentials.signing_secret : "",
          verification_token:
            typeof credentials.verification_token === "string"
              ? credentials.verification_token
              : "",
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed create ${plan.configId}: ${msg}`);
      return { ok: false, action: "create", configId: plan.configId, error: msg };
    }
  }

  if (plan.action === "update" && plan.appId && plan.manifest) {
    try {
      if (dryRun) {
        log(`dry-run: would update Slack app ${plan.configId}`);
        return {
          ok: true,
          action: "update",
          configId: plan.configId,
          appId: plan.appId,
          dryRun: true,
        };
      }
      await api.updateApp(plan.appId, plan.manifest);
      log(`updated ${plan.configId}`);
      return { ok: true, action: "update", configId: plan.configId, appId: plan.appId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed update ${plan.configId}: ${msg}`);
      return { ok: false, action: "update", configId: plan.configId, error: msg };
    }
  }

  return { ok: false, action: plan.action, configId: plan.configId, error: "unsupported plan" };
}
