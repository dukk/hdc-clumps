import {
  effectiveToDesired,
  resolveEffectiveApplication,
} from "./discord-config.mjs";
import { appsNeedUpdate, diffApplication, patchBodyForDrift } from "./discord-diff.mjs";

/**
 * @typedef {import('./discord-config.mjs').ConfigApplication} ConfigApplication
 * @typedef {import('./discord-config.mjs').NormalizedLiveApplication} NormalizedLiveApplication
 */

/**
 * @param {object} opts
 * @param {ConfigApplication} opts.configApp
 * @param {NormalizedLiveApplication | null} opts.live
 * @param {{ noDerive?: boolean; warn?: (msg: string) => void }} [opts]
 */
export function planAppSync(opts) {
  const { configApp, live } = opts;

  if (!configApp.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      configId: configApp.id,
      reason: "not managed",
      patch: null,
      unchanged: false,
    };
  }

  if (!live) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      configId: configApp.id,
      reason: "live application unavailable",
      patch: null,
      unchanged: false,
    };
  }

  const effective = resolveEffectiveApplication(configApp, {
    noDerive: opts.noDerive,
    warn: opts.warn,
  });
  const desired = effectiveToDesired(effective);
  const drift = diffApplication({ desired, live });

  if (!appsNeedUpdate(desired, live, drift)) {
    return {
      action: /** @type {"unchanged"} */ ("unchanged"),
      configId: configApp.id,
      desired,
      live,
      drift,
      patch: null,
      unchanged: true,
    };
  }

  const patch = patchBodyForDrift({ drift, desired, live });
  if (!Object.keys(patch).length) {
    return {
      action: /** @type {"unchanged"} */ ("unchanged"),
      configId: configApp.id,
      desired,
      live,
      drift,
      patch: null,
      unchanged: true,
    };
  }

  return {
    action: /** @type {"update"} */ ("update"),
    configId: configApp.id,
    desired,
    live,
    drift,
    patch,
    unchanged: false,
  };
}

/**
 * @param {ReturnType<import('./discord-api.mjs').createDiscordClient>} api
 * @param {ReturnType<typeof planAppSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyAppSync(api, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip ${plan.configId}: ${plan.reason ?? "skipped"}`);
    return { ok: true, action: "skip", configId: plan.configId, reason: plan.reason };
  }

  if (plan.action === "unchanged") {
    log(`unchanged ${plan.configId}`);
    return {
      ok: true,
      action: "unchanged",
      configId: plan.configId,
      application_id: plan.live?.application_id,
    };
  }

  if (plan.action === "update" && plan.patch) {
    const label = plan.configId;
    try {
      if (dryRun) {
        log(`dry-run: would PATCH /applications/@me for ${label}`);
        return {
          ok: true,
          action: "update",
          configId: plan.configId,
          dryRun: true,
          patch: plan.patch,
        };
      }
      await api.patchCurrentApplication(plan.patch);
      log(`updated ${label} (application_id=${plan.live?.application_id})`);
      return {
        ok: true,
        action: "update",
        configId: plan.configId,
        application_id: plan.live?.application_id,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed update ${label}: ${msg}`);
      return { ok: false, action: "update", configId: plan.configId, error: msg };
    }
  }

  return { ok: false, action: "unknown", configId: plan.configId, error: "unexpected plan state" };
}
