/**
 * Normalize and diff Slack App Manifest config.
 */

export const CLUMP_CONFIG_EXAMPLE = "config.example.json";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @typedef {{
 *   enabled: boolean,
 *   request_url: string,
 *   derive_from: Record<string, unknown> | null,
 *   bot_events: string[],
 * }} SlackEventSubscriptions
 */

/**
 * @typedef {{
 *   command: string,
 *   description: string,
 *   url: string,
 *   derive_from: Record<string, unknown> | null,
 * }} SlackSlashCommand
 */

/**
 * @typedef {{
 *   id: string,
 *   managed: boolean,
 *   match: { app_id: string },
 *   display_name: string,
 *   bot_display_name: string,
 *   bot_scopes: string[],
 *   icon: { repo_path: string, background_color: string, applied_sha256: string } | null,
 *   interactivity: { enabled: boolean, request_url: string, derive_from: Record<string, unknown> | null },
 *   event_subscriptions: SlackEventSubscriptions,
 *   slash_commands: SlackSlashCommand[],
 *   vault: {
 *     signing_secret_key: string,
 *     client_id_key: string,
 *     client_secret_key: string,
 *     bot_token_key: string,
 *   },
 *   portal_checklist: { notes: string },
 *   consumer: string,
 *   notes: string,
 * }} SlackConfigApp
 */

/**
 * Resolve a request URL from explicit value or hdc-agents public_url derive_from.
 *
 * @param {{ request_url?: string, url?: string, derive_from?: Record<string, unknown> | null }} source
 * @param {{ hdcAgentsPublicUrl?: string, defaultPath?: string }} [opts]
 * @returns {string}
 */
export function resolveDerivedRequestUrl(source, opts = {}) {
  const explicit =
    String(source?.request_url ?? "").trim() || String(source?.url ?? "").trim();
  if (explicit) return explicit;
  const derive = source?.derive_from;
  if (!derive || derive.hdc_agents_public_url !== true) return "";
  const base = String(opts.hdcAgentsPublicUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const path =
    typeof derive.path === "string" && derive.path.trim()
      ? derive.path.trim()
      : String(opts.defaultPath ?? "/").trim() || "/";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

/**
 * @param {unknown} raw
 * @returns {{
 *   schema_version: number,
 *   api_base_url: string,
 *   config_token_vault_key: string,
 *   config_refresh_token_vault_key: string,
 *   apps: SlackConfigApp[],
 *   managedApps: SlackConfigApp[],
 *   appsById: Map<string, SlackConfigApp>,
 * }}
 */
export function normalizeSlackConfig(raw) {
  const root = isObject(raw) ? raw : {};
  const slack = isObject(root.slack) ? root.slack : {};
  const defaults = isObject(root.defaults) ? root.defaults : {};
  const defaultManaged = defaults.managed === true;

  const apiBase =
    typeof slack.api_base_url === "string" && slack.api_base_url.trim()
      ? slack.api_base_url.trim().replace(/\/$/, "")
      : "https://slack.com/api";
  const configTokenKey =
    typeof slack.config_token_vault_key === "string" && slack.config_token_vault_key.trim()
      ? slack.config_token_vault_key.trim()
      : "HDC_SLACK_CONFIG_TOKEN";
  const refreshKey =
    typeof slack.config_refresh_token_vault_key === "string" &&
    slack.config_refresh_token_vault_key.trim()
      ? slack.config_refresh_token_vault_key.trim()
      : "HDC_SLACK_CONFIG_REFRESH_TOKEN";

  const appsRaw = Array.isArray(root.apps) ? root.apps : [];
  /** @type {SlackConfigApp[]} */
  const apps = [];
  for (const item of appsRaw) {
    if (!isObject(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const match = isObject(item.match) ? item.match : {};
    const interactivity = isObject(item.interactivity) ? item.interactivity : {};
    const eventsRaw = isObject(item.event_subscriptions) ? item.event_subscriptions : {};
    const vault = isObject(item.vault) ? item.vault : {};
    const checklist = isObject(item.portal_checklist) ? item.portal_checklist : {};
    const iconRaw = isObject(item.icon) ? item.icon : null;
    const scopes = Array.isArray(item.bot_scopes)
      ? item.bot_scopes.map((s) => String(s).trim()).filter(Boolean)
      : ["chat:write", "chat:write.public"];
    const botEvents = Array.isArray(eventsRaw.bot_events)
      ? eventsRaw.bot_events.map((e) => String(e).trim()).filter(Boolean)
      : [];
    /** @type {SlackSlashCommand[]} */
    const slashCommands = [];
    if (Array.isArray(item.slash_commands)) {
      for (const sc of item.slash_commands) {
        if (!isObject(sc)) continue;
        const command = typeof sc.command === "string" ? sc.command.trim() : "";
        if (!command) continue;
        slashCommands.push({
          command: command.startsWith("/") ? command : `/${command}`,
          description:
            typeof sc.description === "string" && sc.description.trim()
              ? sc.description.trim()
              : "Ask the HDC manager agent",
          url: typeof sc.url === "string" ? sc.url.trim() : "",
          derive_from: isObject(sc.derive_from)
            ? /** @type {Record<string, unknown>} */ (sc.derive_from)
            : null,
        });
      }
    }
    const prefix = id.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
    apps.push({
      id,
      managed: item.managed === true || (item.managed == null && defaultManaged),
      match: {
        app_id: typeof match.app_id === "string" ? match.app_id.trim() : "",
      },
      display_name:
        typeof item.display_name === "string" && item.display_name.trim()
          ? item.display_name.trim()
          : id,
      bot_display_name:
        typeof item.bot_display_name === "string" && item.bot_display_name.trim()
          ? item.bot_display_name.trim()
          : typeof item.display_name === "string" && item.display_name.trim()
            ? item.display_name.trim()
            : id,
      bot_scopes: scopes,
      icon: iconRaw
        ? {
            repo_path:
              typeof iconRaw.repo_path === "string" ? iconRaw.repo_path.trim() : "",
            background_color:
              typeof iconRaw.background_color === "string"
                ? iconRaw.background_color.trim()
                : "",
            applied_sha256:
              typeof iconRaw.applied_sha256 === "string"
                ? iconRaw.applied_sha256.trim().toLowerCase()
                : "",
          }
        : null,
      interactivity: {
        enabled: interactivity.enabled !== false,
        request_url:
          typeof interactivity.request_url === "string"
            ? interactivity.request_url.trim()
            : "",
        derive_from: isObject(interactivity.derive_from)
          ? /** @type {Record<string, unknown>} */ (interactivity.derive_from)
          : null,
      },
      event_subscriptions: {
        enabled: eventsRaw.enabled === true,
        request_url:
          typeof eventsRaw.request_url === "string" ? eventsRaw.request_url.trim() : "",
        derive_from: isObject(eventsRaw.derive_from)
          ? /** @type {Record<string, unknown>} */ (eventsRaw.derive_from)
          : null,
        bot_events: botEvents,
      },
      slash_commands: slashCommands,
      vault: {
        signing_secret_key:
          typeof vault.signing_secret_key === "string" && vault.signing_secret_key.trim()
            ? vault.signing_secret_key.trim()
            : `HDC_SLACK_${prefix}_APP_SIGNING_SECRET`,
        client_id_key:
          typeof vault.client_id_key === "string" && vault.client_id_key.trim()
            ? vault.client_id_key.trim()
            : `HDC_SLACK_${prefix}_APP_CLIENT_ID`,
        client_secret_key:
          typeof vault.client_secret_key === "string" && vault.client_secret_key.trim()
            ? vault.client_secret_key.trim()
            : `HDC_SLACK_${prefix}_APP_CLIENT_SECRET`,
        bot_token_key:
          typeof vault.bot_token_key === "string" && vault.bot_token_key.trim()
            ? vault.bot_token_key.trim()
            : "HDC_SLACK_BOT_TOKEN",
      },
      portal_checklist: {
        notes: typeof checklist.notes === "string" ? checklist.notes.trim() : "",
      },
      consumer: typeof item.consumer === "string" ? item.consumer.trim() : "",
      notes: typeof item.notes === "string" ? item.notes.trim() : "",
    });
  }

  /** @type {Map<string, SlackConfigApp>} */
  const appsById = new Map(apps.map((a) => [a.id, a]));
  return {
    schema_version: Number(root.schema_version) || 1,
    api_base_url: apiBase,
    config_token_vault_key: configTokenKey,
    config_refresh_token_vault_key: refreshKey,
    apps,
    managedApps: apps.filter((a) => a.managed),
    appsById,
  };
}

/**
 * @param {SlackConfigApp} app
 * @param {{ hdcAgentsPublicUrl?: string }} [opts]
 */
export function resolveEventSubscriptionsRequestUrl(app, opts = {}) {
  if (!app.event_subscriptions?.enabled) return "";
  return resolveDerivedRequestUrl(app.event_subscriptions, {
    hdcAgentsPublicUrl: opts.hdcAgentsPublicUrl,
    defaultPath: "/api/slack/events",
  });
}

/**
 * @param {SlackConfigApp} app
 * @param {{ hdcAgentsPublicUrl?: string }} [opts]
 * @returns {{ command: string, description: string, url: string }[]}
 */
export function resolveSlashCommands(app, opts = {}) {
  return (app.slash_commands ?? []).map((sc) => ({
    command: sc.command,
    description: sc.description,
    url: resolveDerivedRequestUrl(sc, {
      hdcAgentsPublicUrl: opts.hdcAgentsPublicUrl,
      defaultPath: "/api/slack/commands",
    }),
  }));
}

/**
 * Build Slack App Manifest JSON from a config app (plus resolved request URLs).
 *
 * @param {SlackConfigApp} app
 * @param {{
 *   requestUrl?: string,
 *   eventsRequestUrl?: string,
 *   slashCommands?: { command: string, description: string, url: string }[],
 * }} [opts]
 */
export function configAppToManifest(app, opts = {}) {
  const requestUrl =
    String(opts.requestUrl ?? app.interactivity.request_url ?? "").trim() || undefined;
  const eventsRequestUrl =
    String(opts.eventsRequestUrl ?? app.event_subscriptions.request_url ?? "").trim() ||
    undefined;
  const slashCommands =
    Array.isArray(opts.slashCommands) && opts.slashCommands.length
      ? opts.slashCommands
      : (app.slash_commands ?? [])
          .map((sc) => ({
            command: sc.command,
            description: sc.description,
            url: String(sc.url ?? "").trim(),
          }))
          .filter((sc) => sc.command && sc.url);

  const display = {
    name: app.display_name,
  };
  const bg = app.icon?.background_color;
  if (bg) display.background_color = bg;

  /** @type {Record<string, unknown>} */
  const features = {
    bot_user: {
      display_name: app.bot_display_name,
      always_online: false,
    },
    // Required for DM composer ("Sending messages to this app has been turned off" otherwise).
    app_home: {
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
  };
  if (slashCommands.length) {
    features.slash_commands = slashCommands.map((sc) => ({
      command: sc.command,
      description: sc.description,
      url: sc.url,
      should_escape: false,
    }));
  }

  /** @type {Record<string, unknown>} */
  const settings = {
    interactivity: {
      is_enabled: app.interactivity.enabled === true,
      ...(requestUrl ? { request_url: requestUrl } : {}),
    },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  };
  if (app.event_subscriptions.enabled && eventsRequestUrl) {
    settings.event_subscriptions = {
      request_url: eventsRequestUrl,
      bot_events: [...(app.event_subscriptions.bot_events ?? [])],
    };
  }

  return {
    display_information: display,
    features,
    oauth_config: {
      scopes: {
        bot: [...app.bot_scopes],
      },
    },
    settings,
  };
}

/**
 * @param {Record<string, unknown>} liveManifest
 */
export function liveManifestToNormalized(liveManifest) {
  const m = isObject(liveManifest) ? liveManifest : {};
  const display = isObject(m.display_information) ? m.display_information : {};
  const features = isObject(m.features) ? m.features : {};
  const botUser = isObject(features.bot_user) ? features.bot_user : {};
  const appHome = isObject(features.app_home) ? features.app_home : {};
  const oauth = isObject(m.oauth_config) ? m.oauth_config : {};
  const scopes = isObject(oauth.scopes) ? oauth.scopes : {};
  const settings = isObject(m.settings) ? m.settings : {};
  const interactivity = isObject(settings.interactivity) ? settings.interactivity : {};
  const events = isObject(settings.event_subscriptions) ? settings.event_subscriptions : {};
  const botScopes = Array.isArray(scopes.bot)
    ? scopes.bot.map((s) => String(s).trim()).filter(Boolean).sort()
    : [];
  const botEvents = Array.isArray(events.bot_events)
    ? events.bot_events.map((e) => String(e).trim()).filter(Boolean).sort()
    : [];
  /** @type {string[]} */
  const slashCommands = [];
  if (Array.isArray(features.slash_commands)) {
    for (const sc of features.slash_commands) {
      if (!isObject(sc)) continue;
      const command = typeof sc.command === "string" ? sc.command.trim() : "";
      const url = typeof sc.url === "string" ? sc.url.trim() : "";
      if (!command) continue;
      slashCommands.push(`${command}|${url}`);
    }
    slashCommands.sort();
  }
  return {
    display_name: typeof display.name === "string" ? display.name.trim() : "",
    background_color:
      typeof display.background_color === "string" ? display.background_color.trim() : "",
    bot_display_name:
      typeof botUser.display_name === "string" ? botUser.display_name.trim() : "",
    bot_scopes: botScopes,
    interactivity_enabled: interactivity.is_enabled === true,
    request_url:
      typeof interactivity.request_url === "string" ? interactivity.request_url.trim() : "",
    events_enabled: Boolean(
      typeof events.request_url === "string" && events.request_url.trim(),
    ),
    events_request_url:
      typeof events.request_url === "string" ? events.request_url.trim() : "",
    bot_events: botEvents,
    slash_commands: slashCommands,
    home_tab_enabled: appHome.home_tab_enabled === true,
    messages_tab_enabled: appHome.messages_tab_enabled === true,
    messages_tab_read_only_enabled: appHome.messages_tab_read_only_enabled === true,
  };
}

/**
 * @param {SlackConfigApp} app
 * @param {{
 *   requestUrl?: string,
 *   eventsRequestUrl?: string,
 *   slashCommands?: { command: string, description: string, url: string }[],
 * }} [opts]
 */
export function configAppToDesired(app, opts = {}) {
  const requestUrl = String(opts.requestUrl ?? app.interactivity.request_url ?? "").trim();
  const eventsRequestUrl = String(
    opts.eventsRequestUrl ?? app.event_subscriptions.request_url ?? "",
  ).trim();
  const slashResolved =
    Array.isArray(opts.slashCommands) && opts.slashCommands.length
      ? opts.slashCommands
      : (app.slash_commands ?? []).map((sc) => ({
          command: sc.command,
          description: sc.description,
          url: String(sc.url ?? "").trim(),
        }));
  const slashCommands = slashResolved
    .filter((sc) => sc.command && sc.url)
    .map((sc) => `${sc.command}|${sc.url}`)
    .sort();
  return {
    display_name: app.display_name,
    background_color: app.icon?.background_color ?? "",
    bot_display_name: app.bot_display_name,
    bot_scopes: [...app.bot_scopes].sort(),
    interactivity_enabled: app.interactivity.enabled === true,
    request_url: requestUrl,
    events_enabled: app.event_subscriptions.enabled === true,
    events_request_url: eventsRequestUrl,
    bot_events: [...(app.event_subscriptions.bot_events ?? [])].sort(),
    slash_commands: slashCommands,
    home_tab_enabled: false,
    messages_tab_enabled: true,
    messages_tab_read_only_enabled: false,
  };
}

/**
 * @param {ReturnType<typeof configAppToDesired>} desired
 * @param {ReturnType<typeof liveManifestToNormalized>} live
 */
export function appsNeedUpdate(desired, live) {
  if (desired.display_name !== live.display_name) return true;
  if (desired.background_color !== live.background_color) return true;
  if (desired.bot_display_name !== live.bot_display_name) return true;
  if (desired.interactivity_enabled !== live.interactivity_enabled) return true;
  if (desired.request_url && desired.request_url !== live.request_url) return true;
  if (desired.events_enabled !== live.events_enabled) return true;
  if (desired.events_enabled && desired.events_request_url !== live.events_request_url) {
    return true;
  }
  if (desired.bot_events.join(",") !== live.bot_events.join(",")) return true;
  if (desired.slash_commands.join(",") !== live.slash_commands.join(",")) return true;
  if (desired.home_tab_enabled !== live.home_tab_enabled) return true;
  if (desired.messages_tab_enabled !== live.messages_tab_enabled) return true;
  if (desired.messages_tab_read_only_enabled !== live.messages_tab_read_only_enabled) {
    return true;
  }
  const a = desired.bot_scopes.join(",");
  const b = live.bot_scopes.join(",");
  return a !== b;
}

/**
 * Resolve interactivity request URL from config or hdc-agents public_url.
 *
 * @param {SlackConfigApp} app
 * @param {{ hdcAgentsPublicUrl?: string }} [opts]
 */
export function resolveInteractivityRequestUrl(app, opts = {}) {
  return resolveDerivedRequestUrl(app.interactivity, {
    hdcAgentsPublicUrl: opts.hdcAgentsPublicUrl,
    defaultPath: "/api/slack/interactions",
  });
}

/**
 * Resolve all manifest URLs for an app from hdc-agents public_url.
 *
 * @param {SlackConfigApp} app
 * @param {{ hdcAgentsPublicUrl?: string }} [opts]
 */
export function resolveAppManifestUrls(app, opts = {}) {
  return {
    requestUrl: resolveInteractivityRequestUrl(app, opts),
    eventsRequestUrl: resolveEventSubscriptionsRequestUrl(app, opts),
    slashCommands: resolveSlashCommands(app, opts).filter((sc) => sc.url),
  };
}
