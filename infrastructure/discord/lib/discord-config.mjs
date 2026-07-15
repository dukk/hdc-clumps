import { deriveRedirectUrisFromNginxWaf } from "./derive-redirect-uris.mjs";

/**
 * @typedef {{
 *   id: string;
 *   managed: boolean;
 *   match: { application_id: string | null };
 *   display_name: string;
 *   bot_token_vault_key: string;
 *   public_key: string | null;
 *   ops_decisions: { channel_id: string | null } | null;
 *   description: string | null;
 *   redirect_uris: string[];
 *   interactions_endpoint_url: string | null;
 *   tags: string[];
 *   bot_public: boolean;
 *   bot_require_code_grant: boolean;
 *   derive_from: {
 *     nginx_waf_config_path: string;
 *     site_id: string;
 *     callback_path: string;
 *   } | null;
 *   portal_checklist: {
 *     privileged_intents: string[];
 *     notes: string | null;
 *   };
 *   consumer: string | null;
 *   notes: string | null;
 * }} ConfigApplication
 */

/**
 * @typedef {{
 *   application_id: string;
 *   name: string;
 *   description: string;
 *   redirect_uris: string[];
 *   interactions_endpoint_url: string | null;
 *   tags: string[];
 *   bot_public: boolean;
 *   bot_require_code_grant: boolean;
 * }} NormalizedLiveApplication
 */

export const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/discord/config.example.json";

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} uris
 * @returns {string[]}
 */
export function normalizeUriList(uris) {
  if (!Array.isArray(uris)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const u of uris) {
    const s = String(u ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.sort();
}

/**
 * @param {unknown} tags
 * @returns {string[]}
 */
export function normalizeTagList(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const t of tags) {
    const s = String(t ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.sort();
}

/**
 * @param {string} appId
 */
export function defaultBotTokenVaultKey(appId) {
  const slug = appId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `HDC_DISCORD_${slug}_BOT_TOKEN`;
}

/**
 * @param {import('./discord-api.mjs').DiscordApplication} live
 * @returns {NormalizedLiveApplication}
 */
export function liveAppToNormalized(live) {
  return {
    application_id: String(live.id ?? "").trim(),
    name: String(live.name ?? "").trim(),
    description: typeof live.description === "string" ? live.description : "",
    redirect_uris: normalizeUriList(live.redirect_uris),
    interactions_endpoint_url:
      typeof live.interactions_endpoint_url === "string" &&
      live.interactions_endpoint_url.trim()
        ? live.interactions_endpoint_url.trim()
        : null,
    tags: normalizeTagList(live.tags),
    bot_public: live.bot_public !== false,
    bot_require_code_grant: Boolean(live.bot_require_code_grant),
  };
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeDiscordConfig(cfg) {
  const discord = isObject(cfg.discord) ? cfg.discord : {};
  const apiBase =
    typeof discord.api_base_url === "string" && discord.api_base_url.trim()
      ? discord.api_base_url.trim().replace(/\/$/, "")
      : "https://discord.com/api/v10";
  const developerPortalUrl =
    typeof discord.developer_portal_url === "string" && discord.developer_portal_url.trim()
      ? discord.developer_portal_url.trim()
      : "https://discord.com/developers/applications";

  const defaults = isObject(cfg.defaults) ? cfg.defaults : {};
  const defaultManaged = defaults.managed === true;

  /** @type {ConfigApplication[]} */
  const applications = [];
  const appList = Array.isArray(cfg.applications) ? cfg.applications : [];
  for (const raw of appList) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) continue;

    const matchRaw = isObject(raw.match) ? raw.match : {};
    const applicationId =
      typeof matchRaw.application_id === "string" && matchRaw.application_id.trim()
        ? matchRaw.application_id.trim()
        : null;

    const displayName =
      typeof raw.display_name === "string" && raw.display_name.trim()
        ? raw.display_name.trim()
        : id;

    const botTokenKey =
      typeof raw.bot_token_vault_key === "string" && raw.bot_token_vault_key.trim()
        ? raw.bot_token_vault_key.trim()
        : defaultBotTokenVaultKey(id);

    let deriveFrom = null;
    if (isObject(raw.derive_from)) {
      const df = raw.derive_from;
      const nginxPath =
        typeof df.nginx_waf_config_path === "string" ? df.nginx_waf_config_path.trim() : "";
      const siteId = typeof df.site_id === "string" ? df.site_id.trim() : "";
      const callbackPath =
        typeof df.callback_path === "string" ? df.callback_path.trim() : "";
      if (nginxPath && siteId && callbackPath) {
        deriveFrom = {
          nginx_waf_config_path: nginxPath,
          site_id: siteId,
          callback_path: callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`,
        };
      }
    }

    const portalRaw = isObject(raw.portal_checklist) ? raw.portal_checklist : {};
    const privilegedIntents = Array.isArray(portalRaw.privileged_intents)
      ? portalRaw.privileged_intents.map((i) => String(i).trim()).filter(Boolean)
      : [];
    const portalNotes =
      typeof portalRaw.notes === "string" && portalRaw.notes.trim()
        ? portalRaw.notes.trim()
        : null;

    const publicKey =
      typeof raw.public_key === "string" && raw.public_key.trim() ? raw.public_key.trim() : null;

    /** @type {{ channel_id: string | null } | null} */
    let opsDecisions = null;
    if (isObject(raw.ops_decisions)) {
      const od = raw.ops_decisions;
      const channelId =
        typeof od.channel_id === "string" && od.channel_id.trim() ? od.channel_id.trim() : null;
      opsDecisions = { channel_id: channelId };
    }

    /** @type {ConfigApplication} */
    const app = {
      id,
      managed: typeof raw.managed === "boolean" ? raw.managed : defaultManaged,
      match: { application_id: applicationId },
      display_name: displayName,
      bot_token_vault_key: botTokenKey,
      public_key: publicKey,
      ops_decisions: opsDecisions,
      description:
        typeof raw.description === "string" ? raw.description : raw.description === null ? null : "",
      redirect_uris: normalizeUriList(raw.redirect_uris),
      interactions_endpoint_url:
        typeof raw.interactions_endpoint_url === "string" &&
        raw.interactions_endpoint_url.trim()
          ? raw.interactions_endpoint_url.trim()
          : null,
      tags: normalizeTagList(raw.tags),
      bot_public: raw.bot_public !== false,
      bot_require_code_grant: Boolean(raw.bot_require_code_grant),
      derive_from: deriveFrom,
      portal_checklist: {
        privileged_intents: privilegedIntents,
        notes: portalNotes,
      },
      consumer:
        typeof raw.consumer === "string" && raw.consumer.trim() ? raw.consumer.trim() : null,
      notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null,
    };
    applications.push(app);
  }

  return {
    apiBase,
    developerPortalUrl,
    defaultManaged,
    applications,
    applicationsById: new Map(applications.map((a) => [a.id, a])),
  };
}

/**
 * @param {ConfigApplication} app
 * @param {{ noDerive?: boolean; warn?: (msg: string) => void }} [opts]
 */
export function resolveEffectiveApplication(app, opts = {}) {
  const warn = opts.warn ?? (() => {});
  /** @type {string[]} */
  let redirectUris = [...app.redirect_uris];
  /** @type {{ redirect_uris: string[] } | null} */
  let derived = null;

  if (!opts.noDerive && app.derive_from) {
    try {
      derived = deriveRedirectUrisFromNginxWaf(app.derive_from);
      if (!redirectUris.length) {
        redirectUris = [...derived.redirect_uris];
      } else if (
        derived.redirect_uris.length &&
        JSON.stringify(redirectUris) !== JSON.stringify(derived.redirect_uris)
      ) {
        warn(`${app.id}: explicit redirect_uris differ from nginx-waf derived URIs; using explicit`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${app.id}: derive_from failed: ${msg}`);
    }
  }

  return {
    id: app.id,
    display_name: app.display_name,
    description: app.description,
    redirect_uris: redirectUris,
    interactions_endpoint_url: app.interactions_endpoint_url,
    tags: [...app.tags],
    bot_public: app.bot_public,
    bot_require_code_grant: app.bot_require_code_grant,
    derived,
  };
}

/**
 * Build desired normalized state for diff/sync.
 * @param {ReturnType<typeof resolveEffectiveApplication>} effective
 */
export function effectiveToDesired(effective) {
  return {
    description: effective.description ?? "",
    redirect_uris: effective.redirect_uris,
    interactions_endpoint_url: effective.interactions_endpoint_url,
    tags: effective.tags,
    bot_public: effective.bot_public,
    bot_require_code_grant: effective.bot_require_code_grant,
  };
}

/**
 * @param {import('./discord-api.mjs').DiscordApplication} live
 * @param {Record<string, unknown> | null | undefined} existing
 */
export function liveAppToConfigEntry(live, existing) {
  const norm = liveAppToNormalized(live);
  const existingObj = isObject(existing) ? existing : {};

  const id =
    typeof existingObj.id === "string" && existingObj.id.trim()
      ? existingObj.id.trim()
      : norm.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || `app-${norm.application_id.slice(-6)}`;

  return {
    id,
    managed: typeof existingObj.managed === "boolean" ? existingObj.managed : false,
    match: { application_id: norm.application_id },
    display_name:
      typeof existingObj.display_name === "string" && existingObj.display_name.trim()
        ? existingObj.display_name
        : norm.name || id,
    bot_token_vault_key:
      typeof existingObj.bot_token_vault_key === "string" && existingObj.bot_token_vault_key.trim()
        ? existingObj.bot_token_vault_key
        : defaultBotTokenVaultKey(id),
    public_key:
      typeof existingObj.public_key === "string" && existingObj.public_key.trim()
        ? existingObj.public_key.trim()
        : existingObj.public_key === null
          ? null
          : undefined,
    ops_decisions: isObject(existingObj.ops_decisions) ? existingObj.ops_decisions : undefined,
    description: norm.description || null,
    redirect_uris: norm.redirect_uris,
    interactions_endpoint_url: norm.interactions_endpoint_url,
    tags: norm.tags,
    bot_public: norm.bot_public,
    bot_require_code_grant: norm.bot_require_code_grant,
    derive_from: isObject(existingObj.derive_from) ? existingObj.derive_from : undefined,
    portal_checklist: isObject(existingObj.portal_checklist)
      ? existingObj.portal_checklist
      : { privileged_intents: [], notes: null },
    consumer:
      typeof existingObj.consumer === "string" ? existingObj.consumer : existingObj.consumer ?? null,
    notes: typeof existingObj.notes === "string" ? existingObj.notes : existingObj.notes ?? null,
  };
}

/**
 * @param {ConfigApplication} app
 * @param {NormalizedLiveApplication} live
 */
export function applicationIdMatches(app, live) {
  const configured = app.match.application_id?.trim();
  if (configured && live.application_id && configured !== live.application_id) {
    return false;
  }
  return true;
}
