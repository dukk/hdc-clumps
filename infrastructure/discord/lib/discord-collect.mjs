import {
  applicationIdMatches,
  effectiveToDesired,
  liveAppToNormalized,
  normalizeDiscordConfig,
  resolveEffectiveApplication,
} from "./discord-config.mjs";
import { diffApplication } from "./discord-diff.mjs";
import { createDiscordClient } from "./discord-api.mjs";
import { checkBotTokenPresent, resolveDiscordBotToken } from "./vault-deps.mjs";

/**
 * @param {ReturnType<typeof createDiscordClient>} api
 * @param {(line: string) => void} [log]
 */
export async function fetchLiveApplication(api, log = () => {}) {
  log("fetching GET /applications/@me");
  const live = await api.getCurrentApplication();
  return liveAppToNormalized(live);
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof normalizeDiscordConfig>} opts.config
 * @param {ReturnType<typeof import('./vault-deps.mjs').createDiscordVaultAccess>} opts.vault
 * @param {string | undefined} opts.appFilterId
 * @param {boolean} opts.noDerive
 * @param {boolean} opts.requireVault
 * @param {(msg: string) => void} [opts.warn]
 * @param {(line: string) => void} [opts.log]
 */
export async function collectDiscordState(opts) {
  const { config, vault, appFilterId, noDerive, requireVault } = opts;
  const warn = opts.warn ?? (() => {});
  const log = opts.log ?? (() => {});

  let apps = config.applications;
  if (appFilterId) {
    const one = config.applicationsById.get(appFilterId);
    if (!one) throw new Error(`Application not in config applications[]: ${appFilterId}`);
    apps = [one];
  }

  /** @type {object[]} */
  const applications = [];
  let anyDrift = false;
  let anyVaultMissing = false;
  let anyFetchError = false;

  for (const cfgApp of apps) {
    const effective = resolveEffectiveApplication(cfgApp, { noDerive, warn });
    const desired = effectiveToDesired(effective);

    const botTokenPresent = await checkBotTokenPresent(vault, cfgApp.bot_token_vault_key);
    if (requireVault && !botTokenPresent) {
      anyVaultMissing = true;
    }

    /** @type {import('./discord-config.mjs').NormalizedLiveApplication | null} */
    let live = null;
    /** @type {string | null} */
    let fetchError = null;

    if (botTokenPresent) {
      try {
        const token = await resolveDiscordBotToken(vault, cfgApp.bot_token_vault_key, {
          required: true,
        });
        const api = createDiscordClient({ botToken: token, apiBaseUrl: config.apiBase });
        live = await fetchLiveApplication(api, log);
        if (!applicationIdMatches(cfgApp, live)) {
          fetchError = `live application_id ${live.application_id} does not match config match.application_id ${cfgApp.match.application_id}`;
          live = null;
          anyFetchError = true;
        }
      } catch (e) {
        fetchError = e instanceof Error ? e.message : String(e);
        anyFetchError = true;
      }
    }

    const drift = diffApplication({ desired, live });
    if (drift.has_drift) anyDrift = true;

    applications.push({
      config_id: cfgApp.id,
      display_name: cfgApp.display_name,
      managed: cfgApp.managed,
      consumer: cfgApp.consumer,
      match: cfgApp.match,
      desired: {
        ...desired,
        derived: effective.derived,
      },
      live: live
        ? {
            application_id: live.application_id,
            name: live.name,
            description: live.description,
            redirect_uris: live.redirect_uris,
            interactions_endpoint_url: live.interactions_endpoint_url,
            tags: live.tags,
            bot_public: live.bot_public,
            bot_require_code_grant: live.bot_require_code_grant,
          }
        : null,
      drift,
      vault: {
        bot_token_vault_key: cfgApp.bot_token_vault_key,
        bot_token_present: botTokenPresent,
      },
      portal_checklist: cfgApp.portal_checklist,
      fetch_error: fetchError,
    });
  }

  return {
    applications,
    has_drift: anyDrift,
    vault_incomplete: anyVaultMissing,
    fetch_errors: anyFetchError,
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof normalizeDiscordConfig>} opts.config
 * @param {ReturnType<typeof import('./vault-deps.mjs').createDiscordVaultAccess>} opts.vault
 * @param {(line: string) => void} [opts.log]
 */
export async function fetchLiveApplicationsForImport(opts) {
  const { config, vault, log = () => {} } = opts;
  /** @type {{ configApp: import('./discord-config.mjs').ConfigApplication; live: import('./discord-api.mjs').DiscordApplication }[]} */
  const results = [];

  for (const cfgApp of config.applications) {
    const botTokenPresent = await checkBotTokenPresent(vault, cfgApp.bot_token_vault_key);
    if (!botTokenPresent) {
      log(`import skip ${cfgApp.id}: bot token missing (${cfgApp.bot_token_vault_key})`);
      continue;
    }
    try {
      const token = await resolveDiscordBotToken(vault, cfgApp.bot_token_vault_key, {
        required: true,
      });
      const api = createDiscordClient({ botToken: token, apiBaseUrl: config.apiBase });
      log(`import fetch ${cfgApp.id}: GET /applications/@me`);
      const live = await api.getCurrentApplication();
      results.push({ configApp: cfgApp, live });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`import failed ${cfgApp.id}: ${msg}`);
    }
  }

  return results;
}
