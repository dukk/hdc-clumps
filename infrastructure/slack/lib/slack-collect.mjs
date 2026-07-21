import {
  appsNeedUpdate,
  configAppToDesired,
  liveManifestToNormalized,
  resolveAppManifestUrls,
} from "./slack-config.mjs";
import { collectIconState } from "./slack-icon.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<import('./slack-config.mjs').normalizeSlackConfig>} opts.config
 * @param {ReturnType<import('./slack-api.mjs').createSlackManifestClient>} opts.api
 * @param {{ hdcAgentsPublicUrl?: string; hdcRoot?: string }} [opts.resolveOpts]
 * @param {(line: string) => void} [opts.log]
 */
export async function collectSlackState(opts) {
  const { config, api } = opts;
  const log = opts.log ?? (() => {});
  const resolveOpts = opts.resolveOpts ?? {};

  /** @type {object[]} */
  const managed = [];
  /** @type {object[]} */
  const configuredMissing = [];
  /** @type {object[]} */
  const errors = [];

  for (const app of config.apps) {
    const urls = resolveAppManifestUrls(app, resolveOpts);
    const appId = app.match.app_id;
    if (!appId) {
      if (app.managed) {
        configuredMissing.push({
          id: app.id,
          reason: "match.app_id not set (run deploy or import)",
        });
      }
      managed.push({
        id: app.id,
        managed: app.managed,
        app_id: null,
        drift: app.managed ? "missing" : "unmatched",
        request_url: urls.requestUrl || null,
        events_request_url: urls.eventsRequestUrl || null,
      });
      continue;
    }

    try {
      log(`export ${app.id} (${appId})`);
      const exported = await api.exportApp(appId);
      const manifest =
        exported.manifest && typeof exported.manifest === "object"
          ? /** @type {Record<string, unknown>} */ (exported.manifest)
          : {};
      const desired = configAppToDesired(app, urls);
      const live = liveManifestToNormalized(manifest);
      const drift = appsNeedUpdate(desired, live);
      const iconState = opts.resolveOpts?.hdcRoot
        ? collectIconState(app, opts.resolveOpts.hdcRoot)
        : { configured: false, drift: false };
      managed.push({
        id: app.id,
        managed: app.managed,
        app_id: appId,
        drift: drift ? "update" : "ok",
        icon_drift: iconState.configured ? iconState.drift : undefined,
        icon: iconState.configured ? iconState : undefined,
        desired,
        live,
        request_url: urls.requestUrl || null,
        events_request_url: urls.eventsRequestUrl || null,
        portal_checklist: app.portal_checklist.notes || undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ id: app.id, app_id: appId, error: msg });
      if (app.managed) {
        configuredMissing.push({ id: app.id, reason: msg });
      }
    }
  }

  const ok =
    errors.length === 0 &&
    !managed.some(
      (m) =>
        m.managed &&
        (m.drift === "missing" || m.drift === "update" || m.icon_drift === true),
    );

  return {
    ok,
    api_base_url: config.api_base_url,
    managed,
    configured_missing: configuredMissing,
    errors,
  };
}
