/** @typedef {{ resource_app_id: string; resource_access: { id: string; type: string }[] }} NormalizedResourceAccess */

/** @typedef {{ redirect_uris: string[] }} RedirectBlock */

/**
 * @typedef {{
 *   id: string;
 *   managed: boolean;
 *   match: { client_id?: string; display_name?: string };
 *   display_name: string;
 *   sign_in_audience: string;
 *   web: RedirectBlock;
 *   spa: RedirectBlock;
 *   public_client: RedirectBlock;
 *   required_resource_access: NormalizedResourceAccess[];
 *   identifier_uris: string[];
 * }} ConfigApplication
 */

/**
 * @typedef {{
 *   object_id: string;
 *   client_id: string;
 *   display_name: string;
 *   sign_in_audience: string;
 *   web: RedirectBlock;
 *   spa: RedirectBlock;
 *   public_client: RedirectBlock;
 *   required_resource_access: NormalizedResourceAccess[];
 *   identifier_uris: string[];
 * }} NormalizedLiveApp
 */

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
export function normalizeRedirectUris(uris) {
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
 * @param {unknown} block
 * @returns {RedirectBlock}
 */
function normalizeRedirectBlock(block) {
  if (!isObject(block)) return { redirect_uris: [] };
  const uris = block.redirect_uris ?? block.redirectUris;
  return { redirect_uris: normalizeRedirectUris(uris) };
}

/**
 * @param {unknown} list
 * @returns {NormalizedResourceAccess[]}
 */
export function normalizeRequiredResourceAccess(list) {
  if (!Array.isArray(list)) return [];
  /** @type {NormalizedResourceAccess[]} */
  const out = [];
  for (const item of list) {
    if (!isObject(item)) continue;
    const resourceAppId =
      typeof item.resource_app_id === "string"
        ? item.resource_app_id.trim()
        : typeof item.resourceAppId === "string"
          ? item.resourceAppId.trim()
          : "";
    if (!resourceAppId) continue;
    /** @type {{ id: string; type: string }[]} */
    const access = [];
    const ra = Array.isArray(item.resource_access)
      ? item.resource_access
      : Array.isArray(item.resourceAccess)
        ? item.resourceAccess
        : [];
    for (const a of ra) {
      if (!isObject(a)) continue;
      const id = typeof a.id === "string" ? a.id.trim() : "";
      const type = typeof a.type === "string" ? a.type.trim() : "";
      if (!id || !type) continue;
      access.push({ id, type });
    }
    access.sort((x, y) => x.id.localeCompare(y.id) || x.type.localeCompare(y.type));
    out.push({ resource_app_id: resourceAppId, resource_access: access });
  }
  out.sort((a, b) => a.resource_app_id.localeCompare(b.resource_app_id));
  return out;
}

/**
 * @param {NormalizedResourceAccess[]} a
 * @param {NormalizedResourceAccess[]} b
 */
export function resourceAccessEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {import('./azure-graph-api.mjs').GraphApplication} live
 * @returns {NormalizedLiveApp}
 */
export function liveAppToNormalized(live) {
  const graphAccess = (live.requiredResourceAccess ?? []).map((r) => ({
    resource_app_id: r.resourceAppId,
    resource_access: (r.resourceAccess ?? []).map((a) => ({
      id: String(a.id ?? ""),
      type: String(a.type ?? ""),
    })),
  }));
  return {
    object_id: live.id,
    client_id: live.appId,
    display_name: String(live.displayName ?? "").trim(),
    sign_in_audience: String(live.signInAudience ?? "AzureADMyOrg"),
    web: normalizeRedirectBlock(live.web),
    spa: normalizeRedirectBlock(live.spa),
    public_client: normalizeRedirectBlock(live.publicClient),
    required_resource_access: normalizeRequiredResourceAccess(graphAccess),
    identifier_uris: normalizeRedirectUris(live.identifierUris),
  };
}

/**
 * @param {ConfigApplication} app
 * @returns {NormalizedLiveApp}
 */
export function configAppToDesired(app) {
  return {
    object_id: "",
    client_id: app.match.client_id?.trim() ?? "",
    display_name: app.display_name.trim(),
    sign_in_audience: app.sign_in_audience,
    web: app.web,
    spa: app.spa,
    public_client: app.public_client,
    required_resource_access: app.required_resource_access,
    identifier_uris: app.identifier_uris,
  };
}

/**
 * Flatten v1 (top-level applications) or v2 (entra.*) into a shape the Entra normalizer understands.
 * @param {Record<string, unknown>} cfg
 * @returns {Record<string, unknown>}
 */
export function extractEntraConfigRaw(cfg) {
  if (isObject(cfg.entra)) {
    const entra = /** @type {Record<string, unknown>} */ (cfg.entra);
    return {
      schema_version: typeof cfg.schema_version === "number" ? cfg.schema_version : 2,
      azure: {
        graph_base_url:
          typeof entra.graph_base_url === "string" ? entra.graph_base_url : undefined,
      },
      application_filter: entra.application_filter,
      applications: entra.applications,
      automation: entra.automation,
    };
  }
  return cfg;
}

/**
 * @param {unknown} raw
 * @returns {{
 *   app_id: string;
 *   application_id_env: string;
 *   secret_value_vault_key: string;
 *   secret_id_env: string;
 * }}
 */
export function normalizeEntraAutomation(raw) {
  const block = isObject(raw) ? raw : {};
  const appId =
    typeof block.app_id === "string" && block.app_id.trim()
      ? block.app_id.trim()
      : "hdc";
  const slug = appId.toUpperCase().replace(/-/g, "_");
  const prefix = `HDC_AZURE_ENTRA_${slug}`;
  return {
    app_id: appId,
    application_id_env:
      typeof block.application_id_env === "string" && block.application_id_env.trim()
        ? block.application_id_env.trim()
        : `${prefix}_APPLICATION_ID`,
    secret_value_vault_key:
      typeof block.secret_value_vault_key === "string" && block.secret_value_vault_key.trim()
        ? block.secret_value_vault_key.trim()
        : `${prefix}_SECRET_VALUE`,
    secret_id_env:
      typeof block.secret_id_env === "string" && block.secret_id_env.trim()
        ? block.secret_id_env.trim()
        : `${prefix}_SECRET_ID`,
  };
}

/**
 * Live-app → config entry, preserving local id/managed/notes/consumer when matched.
 * @param {NormalizedLiveApp} live
 * @param {ConfigApplication | Record<string, unknown> | null} [existing]
 */
export function liveAppToConfigEntry(live, existing = null) {
  const base = suggestedConfigEntry(live);
  if (!existing || typeof existing !== "object") return base;
  const ex = /** @type {Record<string, unknown>} */ (existing);
  if (typeof ex.id === "string" && ex.id.trim()) base.id = ex.id.trim();
  if (typeof ex.managed === "boolean") base.managed = ex.managed;
  if (typeof ex.notes === "string") {
    /** @type {Record<string, unknown>} */ (base).notes = ex.notes;
  }
  if (typeof ex.consumer === "string") {
    /** @type {Record<string, unknown>} */ (base).consumer = ex.consumer;
  }
  return base;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeAzureConfig(cfg) {
  const flat = extractEntraConfigRaw(cfg);
  const ae = isObject(flat.azure)
    ? flat.azure
    : isObject(flat.azure_entra)
      ? flat.azure_entra
      : {};
  const graphBase =
    typeof ae.graph_base_url === "string" && ae.graph_base_url.trim()
      ? ae.graph_base_url.trim().replace(/\/$/, "")
      : "https://graph.microsoft.com/v1.0";

  const filter = isObject(flat.application_filter) ? flat.application_filter : {};
  const modeRaw = typeof filter.mode === "string" ? filter.mode.trim().toLowerCase() : "all";
  const mode = modeRaw === "include" || modeRaw === "exclude" ? modeRaw : "all";
  const prefixes = Array.isArray(filter.display_name_prefixes)
    ? filter.display_name_prefixes.map((p) => String(p).trim()).filter(Boolean)
    : [];

  /** @type {ConfigApplication[]} */
  const applications = [];
  const appList = Array.isArray(flat.applications) ? flat.applications : [];
  for (const raw of appList) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) continue;
    const match = isObject(raw.match) ? raw.match : {};
    const displayName =
      typeof raw.display_name === "string"
        ? raw.display_name.trim()
        : typeof match.display_name === "string"
          ? match.display_name.trim()
          : "";
    if (!displayName) continue;

    const audience =
      typeof raw.sign_in_audience === "string" && raw.sign_in_audience.trim()
        ? raw.sign_in_audience.trim()
        : "AzureADMyOrg";

    /** @type {ConfigApplication} */
    const app = {
      id,
      managed: raw.managed === true,
      match: {
        client_id:
          typeof match.client_id === "string" && match.client_id.trim()
            ? match.client_id.trim()
            : undefined,
        display_name:
          typeof match.display_name === "string" && match.display_name.trim()
            ? match.display_name.trim()
            : displayName,
      },
      display_name: displayName,
      sign_in_audience: audience,
      web: normalizeRedirectBlock(raw.web),
      spa: normalizeRedirectBlock(raw.spa),
      public_client: normalizeRedirectBlock(raw.public_client),
      required_resource_access: normalizeRequiredResourceAccess(raw.required_resource_access),
      identifier_uris: normalizeRedirectUris(raw.identifier_uris),
    };
    applications.push(app);
  }

  const schemaVersion = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  const hasCompute =
    isObject(cfg.compute) ||
    (Array.isArray(cfg.deployments) && !isObject(cfg.entra) && !Array.isArray(cfg.applications));

  const automation = normalizeEntraAutomation(flat.automation);

  return {
    schema_version: schemaVersion,
    graphBase,
    applicationFilter: { mode, prefixes },
    applications,
    applicationsById: new Map(applications.map((a) => [a.id, a])),
    managedApplications: applications.filter((a) => a.managed),
    automation,
    hasComputeSection: Boolean(isObject(cfg.compute) || Array.isArray(cfg.deployments)),
    hasCompute,
  };
}

/**
 * @param {string} displayName
 * @param {{ mode: string; prefixes: string[] }} applicationFilter
 */
export function applicationPassesFilter(displayName, applicationFilter) {
  const name = String(displayName ?? "").trim();
  if (!name) return false;
  if (applicationFilter.mode === "all") return true;
  if (!applicationFilter.prefixes.length) {
    return applicationFilter.mode === "exclude";
  }
  const matchesPrefix = applicationFilter.prefixes.some((p) => name.startsWith(p));
  if (applicationFilter.mode === "include") return matchesPrefix;
  if (applicationFilter.mode === "exclude") return !matchesPrefix;
  return true;
}

/**
 * @param {NormalizedLiveApp} live
 * @param {ConfigApplication[]} configApps
 * @returns {ConfigApplication | null}
 */
export function findConfigForLiveApp(live, configApps) {
  if (live.client_id) {
    const cid = live.client_id.trim().toLowerCase();
    const byClient = configApps.find(
      (a) => a.match.client_id?.trim().toLowerCase() === cid
    );
    if (byClient) return byClient;
  }
  const name = live.display_name.trim().toLowerCase();
  if (!name) return null;
  return (
    configApps.find((a) => a.match.display_name?.trim().toLowerCase() === name) ??
    configApps.find((a) => a.display_name.trim().toLowerCase() === name) ??
    null
  );
}

/**
 * @param {NormalizedLiveApp} desired
 * @param {NormalizedLiveApp} live
 */
export function appsNeedUpdate(desired, live) {
  if (desired.display_name !== live.display_name) return true;
  if (desired.sign_in_audience !== live.sign_in_audience) return true;
  if (JSON.stringify(desired.web) !== JSON.stringify(live.web)) return true;
  if (JSON.stringify(desired.spa) !== JSON.stringify(live.spa)) return true;
  if (JSON.stringify(desired.public_client) !== JSON.stringify(live.public_client)) return true;
  if (!resourceAccessEqual(desired.required_resource_access, live.required_resource_access)) {
    return true;
  }
  if (JSON.stringify(desired.identifier_uris) !== JSON.stringify(live.identifier_uris)) {
    return true;
  }
  return false;
}

/**
 * @param {NormalizedLiveApp} live
 * @param {string} [configId]
 */
export function suggestedConfigEntry(live, configId) {
  const fromName = live.display_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const slug = configId ?? (fromName || `app-${live.client_id.slice(0, 8)}`);

  return {
    id: slug,
    managed: false,
    match: {
      client_id: live.client_id,
      display_name: live.display_name,
    },
    display_name: live.display_name,
    sign_in_audience: live.sign_in_audience,
    web: live.web,
    spa: live.spa,
    public_client: live.public_client,
    required_resource_access: live.required_resource_access,
    identifier_uris: live.identifier_uris,
  };
}

/**
 * @param {NormalizedLiveApp} desired
 * @returns {Record<string, unknown>}
 */
export function normalizedToGraphBody(desired) {
  /** @type {Record<string, unknown>} */
  const body = {
    displayName: desired.display_name,
    signInAudience: desired.sign_in_audience,
    web: { redirectUris: desired.web.redirect_uris },
    spa: { redirectUris: desired.spa.redirect_uris },
    publicClient: { redirectUris: desired.public_client.redirect_uris },
    requiredResourceAccess: desired.required_resource_access.map((r) => ({
      resourceAppId: r.resource_app_id,
      resourceAccess: r.resource_access.map((a) => ({ id: a.id, type: a.type })),
    })),
  };
  if (desired.identifier_uris.length) {
    body.identifierUris = desired.identifier_uris;
  }
  return body;
}

/**
 * @param {NormalizedLiveApp} desired
 * @param {NormalizedLiveApp} live
 * @returns {Record<string, unknown>}
 */
export function patchBodyForDrift(desired, live) {
  /** @type {Record<string, unknown>} */
  const body = {};
  if (desired.display_name !== live.display_name) body.displayName = desired.display_name;
  if (desired.sign_in_audience !== live.sign_in_audience) {
    body.signInAudience = desired.sign_in_audience;
  }
  if (JSON.stringify(desired.web) !== JSON.stringify(live.web)) {
    body.web = { redirectUris: desired.web.redirect_uris };
  }
  if (JSON.stringify(desired.spa) !== JSON.stringify(live.spa)) {
    body.spa = { redirectUris: desired.spa.redirect_uris };
  }
  if (JSON.stringify(desired.public_client) !== JSON.stringify(live.public_client)) {
    body.publicClient = { redirectUris: desired.public_client.redirect_uris };
  }
  if (!resourceAccessEqual(desired.required_resource_access, live.required_resource_access)) {
    body.requiredResourceAccess = desired.required_resource_access.map((r) => ({
      resourceAppId: r.resource_app_id,
      resourceAccess: r.resource_access.map((a) => ({ id: a.id, type: a.type })),
    }));
  }
  if (JSON.stringify(desired.identifier_uris) !== JSON.stringify(live.identifier_uris)) {
    body.identifierUris = desired.identifier_uris;
  }
  return body;
}

/** @deprecated Use normalizeAzureConfig */
export const normalizeAzureEntraConfig = normalizeAzureConfig;
