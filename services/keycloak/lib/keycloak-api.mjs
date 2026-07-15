/**
 * Keycloak Admin REST API client (token via admin-cli password grant).
 */
import http from "node:http";
import https from "node:https";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @typedef {object} KeycloakApiClient
 * @property {string} baseUrl
 * @property {string} accessToken
 * @property {(path: string, opts?: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> }) => Promise<unknown>} request
 */

/**
 * Minimal fetch-like helper (supports self-signed HTTPS on LAN).
 * @param {string} url
 * @param {RequestInit} init
 */
function keycloakFetch(url, init) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    /** @type {import("node:https").RequestOptions} */
    const reqOpts = {
      method: init.method ?? "GET",
      headers: init.headers,
      rejectUnauthorized: parsed.protocol === "https:" ? false : undefined,
    };
    const req = lib.request(url, reqOpts, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: res.headers,
          text: async () => body,
        });
      });
    });
    req.on("error", reject);
    if (init.body) req.write(String(init.body));
    req.end();
  });
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {Record<string, string | number | boolean | undefined>} [query]
 */
function buildUrl(baseUrl, path, query) {
  const root = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const u = new URL(`${root}${p}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

/**
 * @param {string} baseUrl
 * @param {string} accessToken
 * @param {string} path
 * @param {{ method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> }} [opts]
 */
export async function keycloakRequest(baseUrl, accessToken, path, opts = {}) {
  const method =
    opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const url = buildUrl(baseUrl, path, opts.query);
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  let body;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await keycloakFetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) {
    const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    throw new Error(`Keycloak API ${method} ${path} → HTTP ${res.status}${preview ? `: ${preview}` : ""}`);
  }
  if (!text || res.status === 204) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Obtain an admin access token via the master realm admin-cli password grant.
 * @param {string} baseUrl
 * @param {{ username: string; password: string }} creds
 */
export async function obtainAdminAccessToken(baseUrl, creds) {
  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root}/realms/master/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "admin-cli",
    username: creds.username,
    password: creds.password,
  }).toString();
  const res = await keycloakFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    throw new Error(`Keycloak token request failed (HTTP ${res.status})${preview ? `: ${preview}` : ""}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Keycloak token response was not JSON");
  }
  const token = isObject(parsed) && typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (!token) throw new Error("Keycloak token response missing access_token");
  return token;
}

/**
 * @param {string} baseUrl
 * @param {string} accessToken
 * @returns {KeycloakApiClient}
 */
export function createKeycloakApiClient(baseUrl, accessToken) {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    baseUrl: root,
    accessToken,
    request: (path, opts = {}) => keycloakRequest(root, accessToken, path, opts),
  };
}

/**
 * @param {string} baseUrl
 * @param {{ username: string; password: string }} creds
 */
export async function createKeycloakApiClientFromPassword(baseUrl, creds) {
  const token = await obtainAdminAccessToken(baseUrl, creds);
  return createKeycloakApiClient(baseUrl, token);
}

/**
 * @param {KeycloakApiClient} client
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listRealms(client) {
  const data = await client.request("/admin/realms");
  return Array.isArray(data) ? data.filter(isObject) : [];
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 */
export async function getRealm(client, realm) {
  return client.request(`/admin/realms/${encodeURIComponent(realm)}`);
}

/**
 * @param {KeycloakApiClient} client
 * @param {Record<string, unknown>} representation
 */
export async function createRealm(client, representation) {
  await client.request("/admin/realms", { method: "POST", body: representation });
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {Record<string, unknown>} representation
 */
export async function updateRealm(client, realm, representation) {
  await client.request(`/admin/realms/${encodeURIComponent(realm)}`, {
    method: "PUT",
    body: representation,
  });
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 */
export async function deleteRealm(client, realm) {
  if (realm === "master") {
    throw new Error("refusing to delete Keycloak master realm");
  }
  await client.request(`/admin/realms/${encodeURIComponent(realm)}`, { method: "DELETE" });
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {{ max?: number; username?: string; exact?: boolean }} [opts]
 */
export async function listUsers(client, realm, opts = {}) {
  const data = await client.request(`/admin/realms/${encodeURIComponent(realm)}/users`, {
    query: {
      max: opts.max ?? 1000,
      username: opts.username,
      exact: opts.exact,
    },
  });
  return Array.isArray(data) ? data.filter(isObject) : [];
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {Record<string, unknown>} representation
 * @returns {Promise<string | null>} user id when discoverable via follow-up list
 */
export async function createUser(client, realm, representation) {
  await client.request(`/admin/realms/${encodeURIComponent(realm)}/users`, {
    method: "POST",
    body: representation,
  });
  const username = typeof representation.username === "string" ? representation.username : "";
  if (!username) return null;
  const found = await listUsers(client, realm, { username, exact: true });
  const row = found[0];
  return row && typeof row.id === "string" ? row.id : null;
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} userId
 * @param {Record<string, unknown>} representation
 */
export async function updateUser(client, realm, userId, representation) {
  await client.request(`/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: representation,
  });
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} userId
 */
export async function deleteUser(client, realm, userId) {
  await client.request(`/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} userId
 * @param {{ value: string; temporary?: boolean }} password
 */
export async function resetUserPassword(client, realm, userId, password) {
  await client.request(
    `/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(userId)}/reset-password`,
    {
      method: "PUT",
      body: {
        type: "password",
        value: password.value,
        temporary: password.temporary === true,
      },
    },
  );
}

/** Built-in realm clients hdc must never prune. */
export const KEYCLOAK_BUILTIN_CLIENT_IDS = new Set([
  "account",
  "account-console",
  "admin-cli",
  "broker",
  "realm-management",
  "security-admin-console",
]);

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {{ max?: number; clientId?: string }} [opts]
 */
export async function listClients(client, realm, opts = {}) {
  const data = await client.request(`/admin/realms/${encodeURIComponent(realm)}/clients`, {
    query: {
      max: opts.max ?? 500,
      clientId: opts.clientId,
    },
  });
  return Array.isArray(data) ? data.filter(isObject) : [];
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} clientUuid
 */
export async function getClient(client, realm, clientUuid) {
  return client.request(
    `/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(clientUuid)}`,
  );
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {Record<string, unknown>} representation
 * @returns {Promise<string | null>} client UUID
 */
export async function createClient(client, realm, representation) {
  await client.request(`/admin/realms/${encodeURIComponent(realm)}/clients`, {
    method: "POST",
    body: representation,
  });
  const clientId = typeof representation.clientId === "string" ? representation.clientId : "";
  if (!clientId) return null;
  const found = await listClients(client, realm, { clientId, max: 5 });
  const exact = found.find((c) => c.clientId === clientId) ?? found[0];
  return exact && typeof exact.id === "string" ? exact.id : null;
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} clientUuid
 * @param {Record<string, unknown>} representation
 */
export async function updateClient(client, realm, clientUuid, representation) {
  await client.request(
    `/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(clientUuid)}`,
    {
      method: "PUT",
      body: representation,
    },
  );
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} clientUuid
 */
export async function deleteClient(client, realm, clientUuid) {
  await client.request(
    `/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(clientUuid)}`,
    { method: "DELETE" },
  );
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} clientUuid
 * @returns {Promise<string>}
 */
export async function getClientSecret(client, realm, clientUuid) {
  const data = await client.request(
    `/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(clientUuid)}/client-secret`,
  );
  if (isObject(data) && typeof data.value === "string" && data.value.trim()) {
    return data.value.trim();
  }
  return "";
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} clientUuid
 * @param {string} secret
 * @param {Record<string, unknown>} [existing]
 */
export async function setClientSecret(client, realm, clientUuid, secret, existing = null) {
  let live = existing && isObject(existing) ? existing : null;
  if (!live) {
    live = /** @type {Record<string, unknown>} */ (await getClient(client, realm, clientUuid));
  }
  await updateClient(client, realm, clientUuid, { ...live, secret });
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 */
export async function listIdentityProviders(client, realm) {
  const data = await client.request(
    `/admin/realms/${encodeURIComponent(realm)}/identity-provider/instances`,
  );
  return Array.isArray(data) ? data.filter(isObject) : [];
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} alias
 */
export async function getIdentityProvider(client, realm, alias) {
  return client.request(
    `/admin/realms/${encodeURIComponent(realm)}/identity-provider/instances/${encodeURIComponent(alias)}`,
  );
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {Record<string, unknown>} representation
 */
export async function createIdentityProvider(client, realm, representation) {
  await client.request(`/admin/realms/${encodeURIComponent(realm)}/identity-provider/instances`, {
    method: "POST",
    body: representation,
  });
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} alias
 * @param {Record<string, unknown>} representation
 */
export async function updateIdentityProvider(client, realm, alias, representation) {
  await client.request(
    `/admin/realms/${encodeURIComponent(realm)}/identity-provider/instances/${encodeURIComponent(alias)}`,
    {
      method: "PUT",
      body: representation,
    },
  );
}

/**
 * @param {KeycloakApiClient} client
 * @param {string} realm
 * @param {string} alias
 */
export async function deleteIdentityProvider(client, realm, alias) {
  await client.request(
    `/admin/realms/${encodeURIComponent(realm)}/identity-provider/instances/${encodeURIComponent(alias)}`,
    { method: "DELETE" },
  );
}

/**
 * @param {import("./keycloak-realms.mjs").KeycloakRealmIdentityProviderConfig} cfg
 * @param {Record<string, unknown> | null} [existing]
 * @param {{ clientSecret?: string | null }} [opts]
 */
export function identityProviderRepresentationFromConfig(cfg, existing = null, opts = {}) {
  /** @type {Record<string, unknown>} */
  const rep = existing && isObject(existing) ? { ...existing } : {};
  rep.alias = cfg.alias;
  rep.providerId = cfg.provider_id;
  rep.enabled = cfg.enabled !== false;
  if (cfg.display_name !== undefined) rep.displayName = cfg.display_name;
  if (cfg.trust_email !== undefined) {
    rep.trustEmail = cfg.trust_email;
  } else if (!existing) {
    rep.trustEmail = true;
  }
  if (cfg.store_token !== undefined) {
    rep.storeToken = cfg.store_token;
  } else if (!existing) {
    rep.storeToken = false;
  }
  if (cfg.link_only !== undefined) {
    rep.linkOnly = cfg.link_only;
  } else if (!existing) {
    rep.linkOnly = false;
  }
  const flowAlias =
    cfg.first_broker_login_flow_alias ||
    (existing && typeof existing.firstBrokerLoginFlowAlias === "string"
      ? existing.firstBrokerLoginFlowAlias
      : "first broker login");
  rep.firstBrokerLoginFlowAlias = flowAlias;

  /** @type {Record<string, string>} */
  const config =
    existing && isObject(existing.config)
      ? Object.fromEntries(
          Object.entries(existing.config).map(([k, v]) => [k, String(v ?? "")]),
        )
      : {};
  config.clientId = cfg.client_id;
  const syncMode = cfg.sync_mode || "IMPORT";
  config.syncMode = syncMode;
  const defaultScope = cfg.default_scope || "openid profile email";
  config.defaultScope = defaultScope;
  if (typeof opts.clientSecret === "string" && opts.clientSecret) {
    config.clientSecret = opts.clientSecret;
  } else {
    // Keycloak GETs often return masked secrets; omit so UPDATE keeps the live value.
    delete config.clientSecret;
  }
  rep.config = config;
  return rep;
}

/**
 * @param {Record<string, unknown>} live
 * @param {import("./keycloak-realms.mjs").KeycloakRealmIdentityProviderConfig} configured
 */
export function identityProviderNeedsUpdate(live, configured) {
  if (configured.enabled !== undefined && (live.enabled !== false) !== configured.enabled) {
    return true;
  }
  if (String(live.providerId ?? "") !== configured.provider_id) return true;
  if (
    configured.display_name !== undefined &&
    String(live.displayName ?? "") !== configured.display_name
  ) {
    return true;
  }
  const wantTrust = configured.trust_email !== undefined ? configured.trust_email : true;
  if (Boolean(live.trustEmail) !== wantTrust) return true;
  const wantStore = configured.store_token === true;
  if (Boolean(live.storeToken) !== wantStore) return true;
  const wantLinkOnly = configured.link_only === true;
  if (Boolean(live.linkOnly) !== wantLinkOnly) return true;
  const wantFlow =
    configured.first_broker_login_flow_alias || "first broker login";
  if (String(live.firstBrokerLoginFlowAlias ?? "") !== wantFlow) return true;
  const liveConfig = isObject(live.config) ? live.config : {};
  if (String(liveConfig.clientId ?? "") !== configured.client_id) return true;
  const wantSync = configured.sync_mode || "IMPORT";
  if (String(liveConfig.syncMode ?? "IMPORT") !== wantSync) return true;
  const wantScope = configured.default_scope || "openid profile email";
  if (String(liveConfig.defaultScope ?? "") !== wantScope) return true;
  return false;
}

/**
 * @param {import("./keycloak-realms.mjs").KeycloakRealmClientConfig} cfg
 * @param {Record<string, unknown> | null} [existing]
 * @param {{ secret?: string | null }} [opts]
 */
export function clientRepresentationFromConfig(cfg, existing = null, opts = {}) {
  /** @type {Record<string, unknown>} */
  const rep = existing && isObject(existing) ? { ...existing } : {};
  rep.clientId = cfg.client_id;
  rep.enabled = cfg.enabled !== false;
  rep.protocol = cfg.protocol || "openid-connect";
  rep.publicClient = cfg.public_client === true;
  if (cfg.name !== undefined) rep.name = cfg.name;
  if (cfg.standard_flow_enabled !== undefined) {
    rep.standardFlowEnabled = cfg.standard_flow_enabled;
  }
  if (cfg.direct_access_grants_enabled !== undefined) {
    rep.directAccessGrantsEnabled = cfg.direct_access_grants_enabled;
  }
  if (cfg.service_accounts_enabled !== undefined) {
    rep.serviceAccountsEnabled = cfg.service_accounts_enabled;
  }
  if (cfg.full_scope_allowed !== undefined) {
    rep.fullScopeAllowed = cfg.full_scope_allowed;
  }
  if (cfg.root_url !== undefined) rep.rootUrl = cfg.root_url;
  if (cfg.base_url !== undefined) rep.baseUrl = cfg.base_url;
  if (cfg.redirect_uris !== undefined) rep.redirectUris = [...cfg.redirect_uris];
  if (cfg.web_origins !== undefined) rep.webOrigins = [...cfg.web_origins];
  if (cfg.public_client !== true) {
    rep.clientAuthenticatorType = "client-secret";
    if (typeof opts.secret === "string" && opts.secret) {
      rep.secret = opts.secret;
    }
  }
  return rep;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function stringArraysEqual(a, b) {
  const aa = Array.isArray(a) ? a.map(String) : [];
  const bb = Array.isArray(b) ? b.map(String) : [];
  if (aa.length !== bb.length) return false;
  const sa = [...aa].sort();
  const sb = [...bb].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * @param {Record<string, unknown>} live
 * @param {import("./keycloak-realms.mjs").KeycloakRealmClientConfig} configured
 */
export function clientNeedsUpdate(live, configured) {
  if (configured.enabled !== undefined && (live.enabled !== false) !== configured.enabled) {
    return true;
  }
  if (configured.name !== undefined && String(live.name ?? "") !== configured.name) return true;
  const wantPublic = configured.public_client === true;
  if (Boolean(live.publicClient) !== wantPublic) return true;
  const wantProtocol = configured.protocol || "openid-connect";
  if (String(live.protocol ?? "openid-connect") !== wantProtocol) return true;
  if (
    configured.standard_flow_enabled !== undefined &&
    Boolean(live.standardFlowEnabled) !== configured.standard_flow_enabled
  ) {
    return true;
  }
  if (
    configured.direct_access_grants_enabled !== undefined &&
    Boolean(live.directAccessGrantsEnabled) !== configured.direct_access_grants_enabled
  ) {
    return true;
  }
  if (
    configured.service_accounts_enabled !== undefined &&
    Boolean(live.serviceAccountsEnabled) !== configured.service_accounts_enabled
  ) {
    return true;
  }
  if (
    configured.full_scope_allowed !== undefined &&
    Boolean(live.fullScopeAllowed) !== configured.full_scope_allowed
  ) {
    return true;
  }
  if (configured.root_url !== undefined && String(live.rootUrl ?? "") !== configured.root_url) {
    return true;
  }
  if (configured.base_url !== undefined && String(live.baseUrl ?? "") !== configured.base_url) {
    return true;
  }
  if (configured.redirect_uris !== undefined && !stringArraysEqual(live.redirectUris, configured.redirect_uris)) {
    return true;
  }
  if (configured.web_origins !== undefined && !stringArraysEqual(live.webOrigins, configured.web_origins)) {
    return true;
  }
  return false;
}

/**
 * Map hdc realm config to a Keycloak RealmRepresentation (partial).
 * @param {import("./keycloak-realms.mjs").KeycloakRealmConfig} realm
 * @param {Record<string, unknown> | null} [existing]
 */
export function realmRepresentationFromConfig(realm, existing = null) {
  /** @type {Record<string, unknown>} */
  const rep = existing && isObject(existing) ? { ...existing } : {};
  rep.realm = realm.realm;
  rep.enabled = realm.enabled;
  if (realm.display_name !== undefined) rep.displayName = realm.display_name;
  if (realm.login_with_email_allowed !== undefined) {
    rep.loginWithEmailAllowed = realm.login_with_email_allowed;
  }
  if (realm.registration_allowed !== undefined) {
    rep.registrationAllowed = realm.registration_allowed;
  }
  if (realm.reset_password_allowed !== undefined) {
    rep.resetPasswordAllowed = realm.reset_password_allowed;
  }
  if (realm.remember_me !== undefined) rep.rememberMe = realm.remember_me;
  if (realm.verify_email !== undefined) rep.verifyEmail = realm.verify_email;
  if (realm.ssl_required !== undefined) rep.sslRequired = realm.ssl_required;
  if (realm.smtp_server) {
    rep.smtpServer = { ...realm.smtp_server };
  }
  return rep;
}

/**
 * @param {import("./keycloak-realms.mjs").KeycloakRealmUserConfig} user
 */
export function userRepresentationFromConfig(user) {
  /** @type {Record<string, unknown>} */
  const rep = {
    username: user.username,
    enabled: user.enabled !== false,
  };
  if (user.email !== undefined) rep.email = user.email;
  if (user.email_verified !== undefined) rep.emailVerified = user.email_verified;
  if (user.first_name !== undefined) rep.firstName = user.first_name;
  if (user.last_name !== undefined) rep.lastName = user.last_name;
  return rep;
}

/**
 * Compare Keycloak smtpServer maps (string fields hdc manages).
 * @param {unknown} liveSmtp
 * @param {Record<string, string>} want
 */
export function smtpServerNeedsUpdate(liveSmtp, want) {
  const live = isObject(liveSmtp) ? liveSmtp : {};
  for (const [key, value] of Object.entries(want)) {
    if (String(live[key] ?? "") !== String(value)) return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown>} live
 * @param {import("./keycloak-realms.mjs").KeycloakRealmConfig} configured
 */
export function realmNeedsUpdate(live, configured) {
  const checks = [
    ["enabled", configured.enabled, live.enabled !== false],
    ["displayName", configured.display_name, live.displayName],
    ["loginWithEmailAllowed", configured.login_with_email_allowed, live.loginWithEmailAllowed],
    ["registrationAllowed", configured.registration_allowed, live.registrationAllowed],
    ["resetPasswordAllowed", configured.reset_password_allowed, live.resetPasswordAllowed],
    ["rememberMe", configured.remember_me, live.rememberMe],
    ["verifyEmail", configured.verify_email, live.verifyEmail],
    ["sslRequired", configured.ssl_required, live.sslRequired],
  ];
  for (const [, want, got] of checks) {
    if (want === undefined) continue;
    if (want !== got) return true;
  }
  if (configured.smtp_server) {
    if (smtpServerNeedsUpdate(live.smtpServer, configured.smtp_server)) return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown>} live
 * @param {import("./keycloak-realms.mjs").KeycloakRealmUserConfig} configured
 */
export function userNeedsUpdate(live, configured) {
  if (configured.enabled !== undefined && (live.enabled !== false) !== configured.enabled) {
    return true;
  }
  if (configured.email !== undefined && String(live.email ?? "") !== configured.email) return true;
  if (
    configured.email_verified !== undefined &&
    Boolean(live.emailVerified) !== configured.email_verified
  ) {
    return true;
  }
  if (configured.first_name !== undefined && String(live.firstName ?? "") !== configured.first_name) {
    return true;
  }
  if (configured.last_name !== undefined && String(live.lastName ?? "") !== configured.last_name) {
    return true;
  }
  return false;
}

/**
 * Reconcile configured realms/users/clients/identity providers against a live Keycloak Admin API client.
 *
 * @param {import("./keycloak-realms.mjs").KeycloakRealmConfig[]} realms
 * @param {KeycloakApiClient} client
 * @param {{
 *   prune?: boolean;
 *   dryRun?: boolean;
 *   rotateUserPasswords?: boolean;
 *   rotateClientSecrets?: boolean;
 *   rotateIdpSecrets?: boolean;
 *   skipIdentityProviders?: boolean;
 *   resolveUserPassword?: (user: import("./keycloak-realms.mjs").KeycloakRealmUserConfig) => Promise<string | null>;
 *   resolveClientSecret?: (cfg: import("./keycloak-realms.mjs").KeycloakRealmClientConfig) => Promise<string | null>;
 *   resolveIdentityProviderSecret?: (idp: import("./keycloak-realms.mjs").KeycloakRealmIdentityProviderConfig) => Promise<string | null>;
 *   log?: (line: string) => void;
 * }} [opts]
 */
export async function reconcileKeycloakRealms(realms, client, opts = {}) {
  const log = opts.log ?? (() => {});
  const prune = opts.prune === true;
  const dryRun = opts.dryRun === true;
  const rotate = opts.rotateUserPasswords === true;
  const rotateClientSecrets = opts.rotateClientSecrets === true;
  const rotateIdpSecrets = opts.rotateIdpSecrets === true;
  const skipIdentityProviders = opts.skipIdentityProviders === true;
  const resolvePw =
    opts.resolveUserPassword ??
    (async () => {
      throw new Error("resolveUserPassword required when creating or rotating users");
    });
  const resolveClientSecret =
    opts.resolveClientSecret ??
    (async () => {
      throw new Error("resolveClientSecret required when creating or rotating confidential clients");
    });
  const resolveIdpSecret =
    opts.resolveIdentityProviderSecret ??
    (async () => {
      throw new Error(
        "resolveIdentityProviderSecret required when creating or rotating identity providers",
      );
    });

  const liveRealms = await listRealms(client);
  const liveByName = new Map(
    liveRealms
      .map((r) => [typeof r.realm === "string" ? r.realm : "", r])
      .filter(([name]) => Boolean(name)),
  );

  const configuredNames = new Set(realms.map((r) => r.realm));
  /** @type {Record<string, unknown>[]} */
  const realmResults = [];
  let addedCount = 0;
  let updatedCount = 0;
  let prunedRealmCount = 0;
  let userAdded = 0;
  let userUpdated = 0;
  let userPruned = 0;
  let passwordSet = 0;
  let clientAdded = 0;
  let clientUpdated = 0;
  let clientPruned = 0;
  let clientSecretsSet = 0;
  let idpAdded = 0;
  let idpUpdated = 0;
  let idpPruned = 0;
  let idpSecretsSet = 0;
  /** @type {string[]} */
  const errors = [];

  for (const realm of realms) {
    if (realm.realm === "master") {
      const msg = `skipping managed config for master realm (id=${realm.id})`;
      log(msg);
      realmResults.push({ ok: true, id: realm.id, realm: realm.realm, skipped: true, message: msg });
      continue;
    }

    /** @type {Record<string, unknown>} */
    const result = {
      ok: true,
      id: realm.id,
      realm: realm.realm,
      realm_added: false,
      realm_updated: false,
      users_added: 0,
      users_updated: 0,
      users_pruned: 0,
      passwords_set: 0,
      clients_added: 0,
      clients_updated: 0,
      clients_pruned: 0,
      client_secrets_set: 0,
      identity_providers_added: 0,
      identity_providers_updated: 0,
      identity_providers_pruned: 0,
      identity_provider_secrets_set: 0,
    };

    try {
      let live = liveByName.get(realm.realm) ?? null;
      if (!live) {
        log(`realm ${realm.realm}: create`);
        if (!dryRun) {
          await createRealm(client, realmRepresentationFromConfig(realm));
          live = /** @type {Record<string, unknown>} */ (await getRealm(client, realm.realm));
          liveByName.set(realm.realm, live);
        }
        result.realm_added = true;
        addedCount += 1;
      } else if (realmNeedsUpdate(live, realm)) {
        log(`realm ${realm.realm}: update settings`);
        if (!dryRun) {
          await updateRealm(client, realm.realm, realmRepresentationFromConfig(realm, live));
          live = /** @type {Record<string, unknown>} */ (await getRealm(client, realm.realm));
          liveByName.set(realm.realm, live);
        }
        result.realm_updated = true;
        updatedCount += 1;
      } else {
        log(`realm ${realm.realm}: settings ok`);
      }

      const liveUsers = dryRun && !live ? [] : await listUsers(client, realm.realm, { max: 2000 });
      const liveUserByName = new Map();
      for (const u of liveUsers) {
        const un = typeof u.username === "string" ? u.username.toLowerCase() : "";
        if (un) liveUserByName.set(un, u);
      }

      const configuredUsernames = new Set(realm.users.map((u) => u.username.toLowerCase()));

      for (const user of realm.users) {
        const key = user.username.toLowerCase();
        const existing = liveUserByName.get(key) ?? null;
        if (!existing) {
          log(`realm ${realm.realm}: create user ${user.username}`);
          let userId = null;
          if (!dryRun) {
            userId = await createUser(client, realm.realm, userRepresentationFromConfig(user));
            if (!userId) {
              const found = await listUsers(client, realm.realm, {
                username: user.username,
                exact: true,
              });
              const row = found[0];
              userId = row && typeof row.id === "string" ? row.id : null;
            }
            if (!userId) throw new Error(`created user ${user.username} but could not resolve id`);
            const pw = await resolvePw(user);
            if (!pw) {
              throw new Error(
                `missing password for ${user.username} — set vault ${user.password_vault_key}`,
              );
            }
            await resetUserPassword(client, realm.realm, userId, {
              value: pw,
              temporary: user.temporary_password === true,
            });
            passwordSet += 1;
            result.passwords_set += 1;
          }
          userAdded += 1;
          result.users_added += 1;
        } else {
          const userId = typeof existing.id === "string" ? existing.id : "";
          if (!userId) throw new Error(`live user ${user.username} missing id`);
          if (userNeedsUpdate(existing, user)) {
            log(`realm ${realm.realm}: update user ${user.username}`);
            if (!dryRun) {
              await updateUser(client, realm.realm, userId, {
                ...existing,
                ...userRepresentationFromConfig(user),
              });
            }
            userUpdated += 1;
            result.users_updated += 1;
          }
          if (rotate) {
            log(`realm ${realm.realm}: rotate password for ${user.username}`);
            if (!dryRun) {
              const pw = await resolvePw(user);
              if (!pw) {
                throw new Error(
                  `missing password for ${user.username} — set vault ${user.password_vault_key}`,
                );
              }
              await resetUserPassword(client, realm.realm, userId, {
                value: pw,
                temporary: user.temporary_password === true,
              });
              passwordSet += 1;
              result.passwords_set += 1;
            }
          }
        }
      }

      if (prune) {
        for (const [uname, row] of liveUserByName) {
          if (configuredUsernames.has(uname)) continue;
          const userId = typeof row.id === "string" ? row.id : "";
          if (!userId) continue;
          log(`realm ${realm.realm}: prune user ${typeof row.username === "string" ? row.username : uname}`);
          if (!dryRun) {
            await deleteUser(client, realm.realm, userId);
          }
          userPruned += 1;
          result.users_pruned += 1;
        }
      }

      const clients = Array.isArray(realm.clients) ? realm.clients : [];
      const liveClients =
        dryRun && !live ? [] : await listClients(client, realm.realm, { max: 500 });
      /** @type {Map<string, Record<string, unknown>>} */
      const liveClientById = new Map();
      for (const c of liveClients) {
        const cid = typeof c.clientId === "string" ? c.clientId : "";
        if (cid) liveClientById.set(cid, c);
      }
      const configuredClientIds = new Set(clients.map((c) => c.client_id));

      for (const cfg of clients) {
        const existing = liveClientById.get(cfg.client_id) ?? null;
        const needsSecret = cfg.public_client !== true;
        if (!existing) {
          log(`realm ${realm.realm}: create client ${cfg.client_id}`);
          if (!dryRun) {
            let secret = null;
            if (needsSecret) {
              secret = await resolveClientSecret(cfg);
              if (!secret) {
                throw new Error(
                  `missing client secret for ${cfg.client_id} — set vault ${cfg.secret_vault_key}`,
                );
              }
            }
            const clientUuid = await createClient(
              client,
              realm.realm,
              clientRepresentationFromConfig(cfg, null, { secret }),
            );
            if (!clientUuid) {
              throw new Error(`created client ${cfg.client_id} but could not resolve id`);
            }
            if (needsSecret && secret) {
              clientSecretsSet += 1;
              result.client_secrets_set += 1;
            }
          }
          clientAdded += 1;
          result.clients_added += 1;
        } else {
          const clientUuid = typeof existing.id === "string" ? existing.id : "";
          if (!clientUuid) throw new Error(`live client ${cfg.client_id} missing id`);
          if (clientNeedsUpdate(existing, cfg)) {
            log(`realm ${realm.realm}: update client ${cfg.client_id}`);
            if (!dryRun) {
              let secret = null;
              if (needsSecret && rotateClientSecrets) {
                secret = await resolveClientSecret(cfg);
              }
              await updateClient(
                client,
                realm.realm,
                clientUuid,
                clientRepresentationFromConfig(cfg, existing, { secret }),
              );
            }
            clientUpdated += 1;
            result.clients_updated += 1;
          } else if (rotateClientSecrets && needsSecret) {
            log(`realm ${realm.realm}: rotate secret for client ${cfg.client_id}`);
            if (!dryRun) {
              const secret = await resolveClientSecret(cfg);
              if (!secret) {
                throw new Error(
                  `missing client secret for ${cfg.client_id} — set vault ${cfg.secret_vault_key}`,
                );
              }
              await setClientSecret(client, realm.realm, clientUuid, secret, existing);
              clientSecretsSet += 1;
              result.client_secrets_set += 1;
            }
          }
        }
      }

      if (prune) {
        for (const [cid, row] of liveClientById) {
          if (configuredClientIds.has(cid)) continue;
          if (KEYCLOAK_BUILTIN_CLIENT_IDS.has(cid)) continue;
          const clientUuid = typeof row.id === "string" ? row.id : "";
          if (!clientUuid) continue;
          log(`realm ${realm.realm}: prune client ${cid}`);
          if (!dryRun) {
            await deleteClient(client, realm.realm, clientUuid);
          }
          clientPruned += 1;
          result.clients_pruned += 1;
        }
      }

      if (!skipIdentityProviders) {
        const idps = Array.isArray(realm.identity_providers) ? realm.identity_providers : [];
        const liveIdps =
          dryRun && !live ? [] : await listIdentityProviders(client, realm.realm);
        /** @type {Map<string, Record<string, unknown>>} */
        const liveIdpByAlias = new Map();
        for (const idp of liveIdps) {
          const alias = typeof idp.alias === "string" ? idp.alias : "";
          if (alias) liveIdpByAlias.set(alias, idp);
        }
        const configuredAliases = new Set(idps.map((idp) => idp.alias));

        for (const cfg of idps) {
          const existing = liveIdpByAlias.get(cfg.alias) ?? null;
          if (!existing) {
            log(`realm ${realm.realm}: create identity provider ${cfg.alias}`);
            if (!dryRun) {
              const secret = await resolveIdpSecret(cfg);
              if (!secret) {
                throw new Error(
                  `missing identity provider secret for ${cfg.alias} — set vault ${cfg.client_secret_vault_key}`,
                );
              }
              await createIdentityProvider(
                client,
                realm.realm,
                identityProviderRepresentationFromConfig(cfg, null, { clientSecret: secret }),
              );
              idpSecretsSet += 1;
              result.identity_provider_secrets_set += 1;
            }
            idpAdded += 1;
            result.identity_providers_added += 1;
          } else if (identityProviderNeedsUpdate(existing, cfg)) {
            log(`realm ${realm.realm}: update identity provider ${cfg.alias}`);
            if (!dryRun) {
              let secret = null;
              if (rotateIdpSecrets) {
                secret = await resolveIdpSecret(cfg);
                if (!secret) {
                  throw new Error(
                    `missing identity provider secret for ${cfg.alias} — set vault ${cfg.client_secret_vault_key}`,
                  );
                }
              }
              await updateIdentityProvider(
                client,
                realm.realm,
                cfg.alias,
                identityProviderRepresentationFromConfig(cfg, existing, { clientSecret: secret }),
              );
              if (secret) {
                idpSecretsSet += 1;
                result.identity_provider_secrets_set += 1;
              }
            }
            idpUpdated += 1;
            result.identity_providers_updated += 1;
          } else if (rotateIdpSecrets) {
            log(`realm ${realm.realm}: rotate secret for identity provider ${cfg.alias}`);
            if (!dryRun) {
              const secret = await resolveIdpSecret(cfg);
              if (!secret) {
                throw new Error(
                  `missing identity provider secret for ${cfg.alias} — set vault ${cfg.client_secret_vault_key}`,
                );
              }
              await updateIdentityProvider(
                client,
                realm.realm,
                cfg.alias,
                identityProviderRepresentationFromConfig(cfg, existing, { clientSecret: secret }),
              );
              idpSecretsSet += 1;
              result.identity_provider_secrets_set += 1;
            }
          }
        }

        if (prune) {
          for (const [alias] of liveIdpByAlias) {
            if (configuredAliases.has(alias)) continue;
            log(`realm ${realm.realm}: prune identity provider ${alias}`);
            if (!dryRun) {
              await deleteIdentityProvider(client, realm.realm, alias);
            }
            idpPruned += 1;
            result.identity_providers_pruned += 1;
          }
        }
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      result.ok = false;
      result.message = msg;
      errors.push(`${realm.realm}: ${msg}`);
      log(`realm ${realm.realm}: error — ${msg}`);
    }

    realmResults.push(result);
  }

  if (prune && realms.length > 0) {
    for (const [name] of liveByName) {
      if (name === "master") continue;
      if (configuredNames.has(name)) continue;
      log(`prune realm ${name}`);
      try {
        if (!dryRun) await deleteRealm(client, name);
        prunedRealmCount += 1;
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        errors.push(`prune ${name}: ${msg}`);
        log(`prune realm ${name}: error — ${msg}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    dry_run: dryRun,
    prune,
    errors,
    realm_results: realmResults,
    summary: {
      configured_count: realms.length,
      added_count: addedCount,
      updated_count: updatedCount,
      pruned_realm_count: prunedRealmCount,
      users_added: userAdded,
      users_updated: userUpdated,
      users_pruned: userPruned,
      passwords_set: passwordSet,
      clients_added: clientAdded,
      clients_updated: clientUpdated,
      clients_pruned: clientPruned,
      client_secrets_set: clientSecretsSet,
      identity_providers_added: idpAdded,
      identity_providers_updated: idpUpdated,
      identity_providers_pruned: idpPruned,
      identity_provider_secrets_set: idpSecretsSet,
    },
  };
}
