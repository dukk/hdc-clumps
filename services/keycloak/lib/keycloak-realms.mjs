/**
 * Normalize keycloak.realms[] and reconcile via Admin REST API.
 */
import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  loadMailRelayAppSettings,
  mailEnabledFromConfig,
} from "hdc/package/mail-relay-settings.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import {
  createKeycloakApiClientFromPassword,
  listClients,
  listIdentityProviders,
  listRealms,
  listUsers,
  reconcileKeycloakRealms,
} from "./keycloak-api.mjs";
import { adminPasswordVaultKey, adminUser, hostPort, normalizeExternalUrl } from "./keycloak-render.mjs";
import { readCtPrimaryIp } from "./keycloak-install.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @typedef {object} KeycloakRealmUserConfig
 * @property {string} username
 * @property {string} [email]
 * @property {boolean} [enabled]
 * @property {boolean} [email_verified]
 * @property {string} [first_name]
 * @property {string} [last_name]
 * @property {string} password_vault_key
 * @property {boolean} [temporary_password]
 */

/**
 * @typedef {object} KeycloakRealmMailConfig
 * @property {boolean} enabled
 * @property {string} [from]
 * @property {string} [from_display_name]
 * @property {string} [reply_to]
 */

/**
 * Keycloak smtpServer map (all string values).
 * @typedef {Record<string, string>} KeycloakSmtpServer
 */

/**
 * @typedef {object} KeycloakRealmClientConfig
 * @property {string} client_id
 * @property {string} [name]
 * @property {boolean} [enabled]
 * @property {string} [protocol]
 * @property {boolean} [public_client]
 * @property {boolean} [standard_flow_enabled]
 * @property {boolean} [direct_access_grants_enabled]
 * @property {boolean} [service_accounts_enabled]
 * @property {boolean} [full_scope_allowed]
 * @property {string} [root_url]
 * @property {string} [base_url]
 * @property {string[]} [redirect_uris]
 * @property {string[]} [web_origins]
 * @property {string} [secret_vault_key]
 */

/**
 * @typedef {object} KeycloakRealmIdentityProviderConfig
 * @property {string} alias
 * @property {string} provider_id
 * @property {boolean} [enabled]
 * @property {string} [display_name]
 * @property {boolean} [trust_email]
 * @property {boolean} [store_token]
 * @property {boolean} [link_only]
 * @property {string} [first_broker_login_flow_alias]
 * @property {string} [sync_mode]
 * @property {string} [default_scope]
 * @property {string} client_id
 * @property {string} client_secret_vault_key
 */

/**
 * @typedef {object} KeycloakRealmConfig
 * @property {string} id
 * @property {string} realm
 * @property {boolean} enabled
 * @property {string} [display_name]
 * @property {boolean} [login_with_email_allowed]
 * @property {boolean} [registration_allowed]
 * @property {boolean} [reset_password_allowed]
 * @property {boolean} [remember_me]
 * @property {boolean} [verify_email]
 * @property {string} [ssl_required]
 * @property {KeycloakRealmMailConfig} [mail]
 * @property {KeycloakSmtpServer} [smtp_server]
 * @property {KeycloakRealmUserConfig[]} users
 * @property {KeycloakRealmClientConfig[]} clients
 * @property {KeycloakRealmIdentityProviderConfig[]} [identity_providers]
 */

/**
 * Build Keycloak smtpServer from realm mail block + postfix-relay client_defaults.
 * @param {unknown} mailBlock
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {KeycloakSmtpServer | null} null when mail is not enabled
 */
export function smtpServerFromMailConfig(mailBlock, opts = {}) {
  if (!mailEnabledFromConfig(mailBlock)) return null;
  const m = isObject(mailBlock) ? mailBlock : {};
  const relay = loadMailRelayAppSettings({ env: opts.env });
  const from =
    typeof m.from === "string" && m.from.trim() ? m.from.trim() : relay.from;
  /** @type {KeycloakSmtpServer} */
  const smtp = {
    host: relay.host,
    port: String(relay.port),
    from,
    ssl: "false",
    starttls: "false",
    auth: "false",
  };
  if (typeof m.from_display_name === "string" && m.from_display_name.trim()) {
    smtp.fromDisplayName = m.from_display_name.trim();
  }
  if (typeof m.reply_to === "string" && m.reply_to.trim()) {
    smtp.replyTo = m.reply_to.trim();
  }
  return smtp;
}

/**
 * @param {unknown} raw
 * @returns {KeycloakRealmMailConfig | undefined}
 */
export function normalizeRealmMail(raw) {
  if (!isObject(raw)) return undefined;
  if (!mailEnabledFromConfig(raw)) return undefined;
  /** @type {KeycloakRealmMailConfig} */
  const mail = { enabled: true };
  if (typeof raw.from === "string" && raw.from.trim()) mail.from = raw.from.trim();
  if (typeof raw.from_display_name === "string" && raw.from_display_name.trim()) {
    mail.from_display_name = raw.from_display_name.trim();
  }
  if (typeof raw.reply_to === "string" && raw.reply_to.trim()) {
    mail.reply_to = raw.reply_to.trim();
  }
  return mail;
}

/**
 * @param {unknown} raw
 * @returns {KeycloakRealmUserConfig}
 */
export function normalizeRealmUser(raw) {
  if (!isObject(raw)) throw new Error("realm user must be an object");
  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  if (!username) throw new Error("realm user needs username");
  const passwordVaultKey =
    typeof raw.password_vault_key === "string" && raw.password_vault_key.trim()
      ? raw.password_vault_key.trim()
      : "";
  if (!passwordVaultKey) {
    throw new Error(`realm user ${username}: password_vault_key is required`);
  }
  /** @type {KeycloakRealmUserConfig} */
  const user = {
    username,
    password_vault_key: passwordVaultKey,
  };
  if (typeof raw.email === "string") user.email = raw.email.trim();
  if (typeof raw.enabled === "boolean") user.enabled = raw.enabled;
  if (typeof raw.email_verified === "boolean") user.email_verified = raw.email_verified;
  if (typeof raw.first_name === "string") user.first_name = raw.first_name.trim();
  if (typeof raw.last_name === "string") user.last_name = raw.last_name.trim();
  if (typeof raw.temporary_password === "boolean") user.temporary_password = raw.temporary_password;
  return user;
}

/**
 * @param {unknown} raw
 * @returns {KeycloakRealmClientConfig}
 */
export function normalizeRealmClient(raw) {
  if (!isObject(raw)) throw new Error("realm client must be an object");
  const clientId = typeof raw.client_id === "string" ? raw.client_id.trim() : "";
  if (!clientId) throw new Error("realm client needs client_id");
  const publicClient = raw.public_client === true;
  const secretVaultKey =
    typeof raw.secret_vault_key === "string" && raw.secret_vault_key.trim()
      ? raw.secret_vault_key.trim()
      : "";
  if (!publicClient && !secretVaultKey) {
    throw new Error(`realm client ${clientId}: secret_vault_key is required for confidential clients`);
  }
  /** @type {KeycloakRealmClientConfig} */
  const client = {
    client_id: clientId,
    public_client: publicClient,
  };
  if (secretVaultKey) client.secret_vault_key = secretVaultKey;
  if (typeof raw.name === "string" && raw.name.trim()) client.name = raw.name.trim();
  if (typeof raw.enabled === "boolean") client.enabled = raw.enabled;
  if (typeof raw.protocol === "string" && raw.protocol.trim()) {
    client.protocol = raw.protocol.trim();
  }
  if (typeof raw.standard_flow_enabled === "boolean") {
    client.standard_flow_enabled = raw.standard_flow_enabled;
  }
  if (typeof raw.direct_access_grants_enabled === "boolean") {
    client.direct_access_grants_enabled = raw.direct_access_grants_enabled;
  }
  if (typeof raw.service_accounts_enabled === "boolean") {
    client.service_accounts_enabled = raw.service_accounts_enabled;
  }
  if (typeof raw.full_scope_allowed === "boolean") {
    client.full_scope_allowed = raw.full_scope_allowed;
  }
  if (typeof raw.root_url === "string" && raw.root_url.trim()) {
    client.root_url = raw.root_url.trim();
  }
  if (typeof raw.base_url === "string" && raw.base_url.trim()) {
    client.base_url = raw.base_url.trim();
  }
  if (Array.isArray(raw.redirect_uris)) {
    client.redirect_uris = raw.redirect_uris
      .map((u) => (typeof u === "string" ? u.trim() : ""))
      .filter(Boolean);
  }
  if (Array.isArray(raw.web_origins)) {
    client.web_origins = raw.web_origins
      .map((u) => (typeof u === "string" ? u.trim() : ""))
      .filter((u) => u.length > 0);
  }
  return client;
}

/**
 * @param {unknown} raw
 * @returns {KeycloakRealmIdentityProviderConfig}
 */
export function normalizeRealmIdentityProvider(raw) {
  if (!isObject(raw)) throw new Error("realm identity_provider must be an object");
  const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";
  if (!alias) throw new Error("realm identity_provider needs alias");
  const providerId = typeof raw.provider_id === "string" ? raw.provider_id.trim() : "";
  if (!providerId) throw new Error(`identity_provider ${alias}: provider_id is required`);
  const clientId = typeof raw.client_id === "string" ? raw.client_id.trim() : "";
  if (!clientId) throw new Error(`identity_provider ${alias}: client_id is required`);
  const secretVaultKey =
    typeof raw.client_secret_vault_key === "string" ? raw.client_secret_vault_key.trim() : "";
  if (!secretVaultKey) {
    throw new Error(`identity_provider ${alias}: client_secret_vault_key is required`);
  }
  /** @type {KeycloakRealmIdentityProviderConfig} */
  const idp = {
    alias,
    provider_id: providerId,
    client_id: clientId,
    client_secret_vault_key: secretVaultKey,
  };
  if (typeof raw.enabled === "boolean") idp.enabled = raw.enabled;
  if (typeof raw.display_name === "string" && raw.display_name.trim()) {
    idp.display_name = raw.display_name.trim();
  }
  if (typeof raw.trust_email === "boolean") idp.trust_email = raw.trust_email;
  if (typeof raw.store_token === "boolean") idp.store_token = raw.store_token;
  if (typeof raw.link_only === "boolean") idp.link_only = raw.link_only;
  if (typeof raw.first_broker_login_flow_alias === "string" && raw.first_broker_login_flow_alias.trim()) {
    idp.first_broker_login_flow_alias = raw.first_broker_login_flow_alias.trim();
  }
  if (typeof raw.sync_mode === "string" && raw.sync_mode.trim()) {
    idp.sync_mode = raw.sync_mode.trim().toUpperCase();
  }
  if (typeof raw.default_scope === "string" && raw.default_scope.trim()) {
    idp.default_scope = raw.default_scope.trim();
  }
  return idp;
}

/**
 * @param {unknown} raw
 * @returns {KeycloakRealmConfig}
 */
export function normalizeRealm(raw) {
  if (!isObject(raw)) throw new Error("realm entry must be an object");
  const realmName =
    typeof raw.realm === "string" && raw.realm.trim()
      ? raw.realm.trim()
      : typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : "";
  if (!realmName) throw new Error("realm entry needs realm (or id)");
  if (realmName === "master") {
    throw new Error('configured realms must not use realm name "master"');
  }
  const id =
    typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : realmName;
  const usersRaw = Array.isArray(raw.users) ? raw.users : [];
  const users = usersRaw.map((u, i) => {
    try {
      return normalizeRealmUser(u);
    } catch (e) {
      throw new Error(`realm ${id} users[${i}]: ${/** @type {Error} */ (e).message}`);
    }
  });
  const usernames = new Set();
  for (const u of users) {
    const key = u.username.toLowerCase();
    if (usernames.has(key)) {
      throw new Error(`realm ${id}: duplicate username ${JSON.stringify(u.username)}`);
    }
    usernames.add(key);
  }
  const clientsRaw = Array.isArray(raw.clients) ? raw.clients : [];
  const clients = clientsRaw.map((c, i) => {
    try {
      return normalizeRealmClient(c);
    } catch (e) {
      throw new Error(`realm ${id} clients[${i}]: ${/** @type {Error} */ (e).message}`);
    }
  });
  const clientIds = new Set();
  for (const c of clients) {
    if (clientIds.has(c.client_id)) {
      throw new Error(`realm ${id}: duplicate client_id ${JSON.stringify(c.client_id)}`);
    }
    clientIds.add(c.client_id);
  }
  const idpsRaw = Array.isArray(raw.identity_providers) ? raw.identity_providers : [];
  const identityProviders = idpsRaw.map((idp, i) => {
    try {
      return normalizeRealmIdentityProvider(idp);
    } catch (e) {
      throw new Error(`realm ${id} identity_providers[${i}]: ${/** @type {Error} */ (e).message}`);
    }
  });
  const idpAliases = new Set();
  for (const idp of identityProviders) {
    if (idpAliases.has(idp.alias)) {
      throw new Error(`realm ${id}: duplicate identity_provider alias ${JSON.stringify(idp.alias)}`);
    }
    idpAliases.add(idp.alias);
  }
  /** @type {KeycloakRealmConfig} */
  const realm = {
    id,
    realm: realmName,
    enabled: raw.enabled !== false,
    users,
    clients,
    identity_providers: identityProviders,
  };
  if (typeof raw.display_name === "string") realm.display_name = raw.display_name.trim();
  if (typeof raw.login_with_email_allowed === "boolean") {
    realm.login_with_email_allowed = raw.login_with_email_allowed;
  }
  if (typeof raw.registration_allowed === "boolean") {
    realm.registration_allowed = raw.registration_allowed;
  }
  if (typeof raw.reset_password_allowed === "boolean") {
    realm.reset_password_allowed = raw.reset_password_allowed;
  }
  if (typeof raw.remember_me === "boolean") realm.remember_me = raw.remember_me;
  if (typeof raw.verify_email === "boolean") realm.verify_email = raw.verify_email;
  if (typeof raw.ssl_required === "string" && raw.ssl_required.trim()) {
    realm.ssl_required = raw.ssl_required.trim();
  }
  const mail = normalizeRealmMail(raw.mail);
  if (mail) {
    realm.mail = mail;
    if (mail.enabled) {
      const smtp = smtpServerFromMailConfig(mail);
      if (smtp) realm.smtp_server = smtp;
    }
  }
  return realm;
}

/**
 * @param {Record<string, unknown>} keycloak
 * @returns {KeycloakRealmConfig[]}
 */
export function normalizeRealmList(keycloak) {
  const kc = isObject(keycloak) ? keycloak : {};
  const raw = Array.isArray(kc.realms) ? kc.realms : [];
  if (!raw.length) return [];
  const out = raw.map((entry, i) => {
    try {
      return normalizeRealm(entry);
    } catch (e) {
      throw new Error(`keycloak.realms[${i}]: ${/** @type {Error} */ (e).message}`);
    }
  });
  const ids = new Set();
  const names = new Set();
  for (const r of out) {
    if (ids.has(r.id)) throw new Error(`duplicate realm id ${JSON.stringify(r.id)}`);
    if (names.has(r.realm)) throw new Error(`duplicate realm name ${JSON.stringify(r.realm)}`);
    ids.add(r.id);
    names.add(r.realm);
  }
  return out;
}

/**
 * Resolve Admin API base URL.
 * Priority: api_url → external_url/public_url → http://ctIp:hostPort
 *
 * @param {Record<string, unknown>} keycloak
 * @param {{ ctIp?: string | null }} [opts]
 */
export function resolveKeycloakApiBaseUrl(keycloak, opts = {}) {
  const kc = isObject(keycloak) ? keycloak : {};
  const apiUrl = typeof kc.api_url === "string" ? kc.api_url.trim().replace(/\/+$/, "") : "";
  if (apiUrl) {
    if (!/^https?:\/\//i.test(apiUrl)) {
      throw new Error("keycloak.api_url must start with http:// or https://");
    }
    return apiUrl;
  }
  try {
    return normalizeExternalUrl(kc);
  } catch {
    /* fall through to CT IP */
  }
  const ctIp = typeof opts.ctIp === "string" ? opts.ctIp.trim() : "";
  if (ctIp) {
    return `http://${ctIp}:${hostPort(kc)}`;
  }
  throw new Error(
    "keycloak.api_url, external_url/public_url, or CT IP required for Admin API",
  );
}

/**
 * @param {unknown} vault
 * @param {KeycloakRealmUserConfig} user
 * @param {{ autoGenerate?: boolean; log?: (line: string) => void }} [opts]
 */
export async function resolveUserPassword(vault, user, opts = {}) {
  const log = opts.log ?? (() => {});
  const key = user.password_vault_key;
  await vault.unlock({});
  let existing = "";
  if (typeof vault.getSecret === "function") {
    existing = String(await vault.getSecret(key, { promptLabel: `vault secret ${key}` })).trim();
  } else {
    const data = await vault.readSecrets({});
    existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  }
  if (existing) {
    log(`user password loaded from vault ${key}`);
    return existing;
  }
  if (opts.autoGenerate !== false) {
    const generated = randomBytes(18).toString("base64url");
    await vault.setSecret(key, generated);
    log(`generated user password and saved to vault ${key}`);
    return generated;
  }
  return null;
}

/**
 * @param {unknown} vault
 * @param {KeycloakRealmClientConfig} clientCfg
 * @param {{ autoGenerate?: boolean; log?: (line: string) => void }} [opts]
 */
export async function resolveClientSecret(vault, clientCfg, opts = {}) {
  const log = opts.log ?? (() => {});
  const key = clientCfg.secret_vault_key;
  if (!key) return null;
  await vault.unlock({});
  let existing = "";
  if (typeof vault.getSecret === "function") {
    existing = String(await vault.getSecret(key, { promptLabel: `vault secret ${key}` })).trim();
  } else {
    const data = await vault.readSecrets({});
    existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  }
  if (existing) {
    log(`client secret loaded from vault ${key}`);
    return existing;
  }
  if (opts.autoGenerate !== false) {
    const generated = randomBytes(32).toString("base64url");
    await vault.setSecret(key, generated);
    log(`generated client secret and saved to vault ${key}`);
    return generated;
  }
  return null;
}

/**
 * Load IdP client secret from vault (never auto-mint — Entra owns the secret).
 * @param {unknown} vault
 * @param {KeycloakRealmIdentityProviderConfig} idp
 * @param {{ log?: (line: string) => void }} [opts]
 */
export async function resolveIdentityProviderSecret(vault, idp, opts = {}) {
  const log = opts.log ?? (() => {});
  const key = idp.client_secret_vault_key;
  await vault.unlock({});
  let existing = "";
  if (typeof vault.getSecret === "function") {
    existing = String(await vault.getSecret(key, { promptLabel: `vault secret ${key}` })).trim();
  } else {
    const data = await vault.readSecrets({});
    existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  }
  if (existing) {
    log(`identity provider secret loaded from vault ${key}`);
    return existing;
  }
  return null;
}

/**
 * Wait until Keycloak reports ready inside the CT (pct exec curl).
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} keycloak
 * @param {{ timeoutMs?: number; intervalMs?: number; log?: (line: string) => void }} [opts]
 */
export async function waitKeycloakHealthInCt(user, pveHost, vmid, keycloak, opts = {}) {
  const log = opts.log ?? ((line) => errout.write(`[hdc] keycloak: ${line}\n`));
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 4000;
  const port = hostPort(isObject(keycloak) ? keycloak : {});
  const deadline = Date.now() + timeoutMs;
  log(`waiting for Keycloak health (CT ${vmid}, up to ${Math.round(timeoutMs / 1000)}s) …`);
  while (Date.now() < deadline) {
    const health = pctExec(
      user,
      pveHost,
      vmid,
      `curl -sf --max-time 5 http://127.0.0.1:9000/health/ready -o /dev/null && echo ok || (curl -sf --max-time 5 http://127.0.0.1:${port}/health/ready -o /dev/null && echo ok || echo fail)`,
      { capture: true },
    );
    if (health.status === 0 && health.stdout.trim() === "ok") {
      log("Keycloak health ready");
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  log("Keycloak health wait timed out");
  return false;
}

/**
 * Filter realms by --realm id or name.
 * @param {KeycloakRealmConfig[]} realms
 * @param {string | undefined} filter
 */
export function filterRealmsByFlag(realms, filter) {
  const f = typeof filter === "string" ? filter.trim() : "";
  if (!f) return realms;
  const matched = realms.filter(
    (r) => r.id === f || r.realm === f || r.id.toLowerCase() === f.toLowerCase(),
  );
  if (!matched.length) {
    throw new Error(`no configured realm matches --realm ${JSON.stringify(f)}`);
  }
  return matched;
}

/**
 * Build realm/user/client/IdP drift fields for query --live.
 * @param {KeycloakRealmConfig[]} configured
 * @param {Record<string, unknown>[]} liveRealms
 * @param {Map<string, string[]>} liveUsersByRealm
 * @param {Map<string, string[]>} [liveClientsByRealm]
 * @param {Map<string, string[]>} [liveIdpsByRealm]
 */
export function buildRealmDriftFields(
  configured,
  liveRealms,
  liveUsersByRealm,
  liveClientsByRealm = new Map(),
  liveIdpsByRealm = new Map(),
) {
  const configuredNames = configured.map((r) => r.realm);
  const liveNames = liveRealms
    .map((r) => (typeof r.realm === "string" ? r.realm : ""))
    .filter(Boolean);
  const configuredSet = new Set(configuredNames);
  const liveSet = new Set(liveNames);
  /** @type {Record<string, unknown>[]} */
  const perRealm = [];
  for (const r of configured) {
    const liveUsers = liveUsersByRealm.get(r.realm) ?? [];
    const configuredUsers = r.users.map((u) => u.username.toLowerCase());
    const liveLower = liveUsers.map((u) => u.toLowerCase());
    const cfgSet = new Set(configuredUsers);
    const liveUserSet = new Set(liveLower);
    const liveClients = liveClientsByRealm.get(r.realm) ?? [];
    const configuredClients = (r.clients ?? []).map((c) => c.client_id);
    const cfgClientSet = new Set(configuredClients);
    const liveClientSet = new Set(liveClients);
    const liveIdps = liveIdpsByRealm.get(r.realm) ?? [];
    const configuredIdps = (r.identity_providers ?? []).map((idp) => idp.alias);
    const cfgIdpSet = new Set(configuredIdps);
    const liveIdpSet = new Set(liveIdps);
    perRealm.push({
      id: r.id,
      realm: r.realm,
      present: liveSet.has(r.realm),
      configured_usernames: r.users.map((u) => u.username),
      live_usernames: liveUsers,
      missing_users: configuredUsers.filter((u) => !liveUserSet.has(u)),
      extra_users: liveLower.filter((u) => !cfgSet.has(u)),
      configured_client_ids: configuredClients,
      live_client_ids: liveClients,
      missing_clients: configuredClients.filter((c) => !liveClientSet.has(c)),
      extra_clients: liveClients.filter((c) => !cfgClientSet.has(c)),
      configured_identity_provider_aliases: configuredIdps,
      live_identity_provider_aliases: liveIdps,
      missing_identity_providers: configuredIdps.filter((a) => !liveIdpSet.has(a)),
      extra_identity_providers: liveIdps.filter((a) => !cfgIdpSet.has(a)),
    });
  }
  return {
    configured_realms: configuredNames,
    live_realms: liveNames.filter((n) => n !== "master"),
    missing_realms: configuredNames.filter((n) => !liveSet.has(n)),
    extra_realms: liveNames.filter((n) => n !== "master" && !configuredSet.has(n)),
    realms: perRealm,
  };
}

/**
 * @param {Record<string, unknown>} keycloak
 * @param {unknown} vault
 * @param {{
 *   skipRealms?: boolean;
 *   skipIdentityProviders?: boolean;
 *   prune?: boolean;
 *   dryRun?: boolean;
 *   rotateUserPasswords?: boolean;
 *   rotateClientSecrets?: boolean;
 *   rotateIdpSecrets?: boolean;
 *   realmFilter?: string;
 *   adminPassword?: string;
 *   ctIp?: string | null;
 *   pveUser?: string;
 *   pveHost?: string;
 *   vmid?: number;
 *   waitHealth?: boolean;
 *   log?: (line: string) => void;
 * }} [opts]
 */
export async function reconcileKeycloakRealmsForConfig(keycloak, vault, opts = {}) {
  const log = opts.log ?? ((line) => errout.write(`[hdc] keycloak: ${line}\n`));
  if (opts.skipRealms) {
    return { ok: true, skipped: true, message: "realms skipped" };
  }

  const kc = isObject(keycloak) ? keycloak : {};
  let realms = normalizeRealmList(kc);
  if (opts.realmFilter) {
    realms = filterRealmsByFlag(realms, opts.realmFilter);
  }
  if (!realms.length) {
    log("no keycloak.realms configured — skipping Admin API reconcile");
    return { ok: true, skipped: true, message: "no realms configured", summary: { configured_count: 0 } };
  }

  let ctIp = opts.ctIp ?? null;
  if (
    !ctIp &&
    typeof opts.pveUser === "string" &&
    typeof opts.pveHost === "string" &&
    typeof opts.vmid === "number"
  ) {
    ctIp = readCtPrimaryIp(opts.pveUser, opts.pveHost, opts.vmid);
  }

  if (
    opts.waitHealth !== false &&
    typeof opts.pveUser === "string" &&
    typeof opts.pveHost === "string" &&
    typeof opts.vmid === "number"
  ) {
    const ready = await waitKeycloakHealthInCt(opts.pveUser, opts.pveHost, opts.vmid, kc, { log });
    if (!ready) {
      return { ok: false, message: "Keycloak health not ready; cannot reconcile realms" };
    }
  }

  const baseUrl = resolveKeycloakApiBaseUrl(kc, { ctIp });
  log(`Admin API base ${baseUrl}`);

  let adminPassword = typeof opts.adminPassword === "string" ? opts.adminPassword.trim() : "";
  if (!adminPassword) {
    const adminKey = adminPasswordVaultKey(kc);
    await vault.unlock({});
    adminPassword = String(
      await vault.getSecret(adminKey, { promptLabel: `vault secret ${adminKey}` }),
    ).trim();
  }
  if (!adminPassword) {
    throw new Error(`missing admin password (vault ${adminPasswordVaultKey(kc)})`);
  }

  const client = await createKeycloakApiClientFromPassword(baseUrl, {
    username: adminUser(kc),
    password: adminPassword,
  });

  const result = await reconcileKeycloakRealms(realms, client, {
    prune: opts.prune === true,
    dryRun: opts.dryRun === true,
    rotateUserPasswords: opts.rotateUserPasswords === true,
    rotateClientSecrets: opts.rotateClientSecrets === true,
    rotateIdpSecrets: opts.rotateIdpSecrets === true,
    skipIdentityProviders: opts.skipIdentityProviders === true,
    resolveUserPassword: (user) =>
      resolveUserPassword(vault, user, {
        autoGenerate: true,
        log: (line) => log(line),
      }),
    resolveClientSecret: (cfg) =>
      resolveClientSecret(vault, cfg, {
        autoGenerate: true,
        log: (line) => log(line),
      }),
    resolveIdentityProviderSecret: (idp) =>
      resolveIdentityProviderSecret(vault, idp, {
        log: (line) => log(line),
      }),
    log,
  });

  return result;
}

/**
 * Query realm/user drift against live Admin API (read-only).
 * @param {Record<string, unknown>} keycloak
 * @param {unknown} vault
 * @param {{
 *   adminPassword?: string;
 *   ctIp?: string | null;
 *   realmFilter?: string;
 *   log?: (line: string) => void;
 * }} [opts]
 */
export async function queryKeycloakRealmDrift(keycloak, vault, opts = {}) {
  const log = opts.log ?? ((line) => errout.write(`[hdc] keycloak: ${line}\n`));
  const kc = isObject(keycloak) ? keycloak : {};
  let realms = normalizeRealmList(kc);
  if (opts.realmFilter) {
    realms = filterRealmsByFlag(realms, opts.realmFilter);
  }

  const baseUrl = resolveKeycloakApiBaseUrl(kc, { ctIp: opts.ctIp ?? null });
  let adminPassword = typeof opts.adminPassword === "string" ? opts.adminPassword.trim() : "";
  if (!adminPassword) {
    const adminKey = adminPasswordVaultKey(kc);
    await vault.unlock({});
    adminPassword = String(
      await vault.getSecret(adminKey, { promptLabel: `vault secret ${adminKey}` }),
    ).trim();
  }
  if (!adminPassword) {
    return { ok: false, message: `missing admin password (vault ${adminPasswordVaultKey(kc)})` };
  }

  const client = await createKeycloakApiClientFromPassword(baseUrl, {
    username: adminUser(kc),
    password: adminPassword,
  });

  const liveRealms = await listRealms(client);
  /** @type {Map<string, string[]>} */
  const liveUsersByRealm = new Map();
  /** @type {Map<string, string[]>} */
  const liveClientsByRealm = new Map();
  /** @type {Map<string, string[]>} */
  const liveIdpsByRealm = new Map();
  for (const r of realms) {
    if (!liveRealms.some((lr) => lr.realm === r.realm)) {
      liveUsersByRealm.set(r.realm, []);
      liveClientsByRealm.set(r.realm, []);
      liveIdpsByRealm.set(r.realm, []);
      continue;
    }
    try {
      const users = await listUsers(client, r.realm, { max: 2000 });
      liveUsersByRealm.set(
        r.realm,
        users
          .map((u) => (typeof u.username === "string" ? u.username : ""))
          .filter(Boolean),
      );
    } catch (e) {
      log(`list users for ${r.realm}: ${/** @type {Error} */ (e).message}`);
      liveUsersByRealm.set(r.realm, []);
    }
    try {
      const clients = await listClients(client, r.realm, { max: 500 });
      liveClientsByRealm.set(
        r.realm,
        clients
          .map((c) => (typeof c.clientId === "string" ? c.clientId : ""))
          .filter(Boolean),
      );
    } catch (e) {
      log(`list clients for ${r.realm}: ${/** @type {Error} */ (e).message}`);
      liveClientsByRealm.set(r.realm, []);
    }
    try {
      const idps = await listIdentityProviders(client, r.realm);
      liveIdpsByRealm.set(
        r.realm,
        idps
          .map((idp) => (typeof idp.alias === "string" ? idp.alias : ""))
          .filter(Boolean),
      );
    } catch (e) {
      log(`list identity providers for ${r.realm}: ${/** @type {Error} */ (e).message}`);
      liveIdpsByRealm.set(r.realm, []);
    }
  }

  return {
    ok: true,
    api_url: baseUrl,
    ...buildRealmDriftFields(realms, liveRealms, liveUsersByRealm, liveClientsByRealm, liveIdpsByRealm),
  };
}
