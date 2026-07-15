/** @typedef {{ redirect_uris: string[]; javascript_origins: string[] }} UriBlock */

/**
 * @typedef {{
 *   id: string;
 *   display_name: string;
 *   client_type: string;
 *   redirect_uris: string[];
 *   javascript_origins: string[];
 *   scopes: string[];
 *   derive_from: {
 *     nginx_waf_config_path: string;
 *     site_id: string;
 *     callback_path: string;
 *   } | null;
 *   vault: { client_id_key: string; client_secret_key: string };
 *   existing_client_id: string | null;
 *   import_match: string | null;
 * }} ConfigApplication
 */

/**
 * @typedef {{
 *   client_id: string;
 *   client_secret: string;
 *   redirect_uris: string[];
 *   javascript_origins: string[];
 *   display_name: string | null;
 *   project_id: string | null;
 * }} NormalizedImportClient
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
 * @param {string} appId
 * @param {boolean} [suffixFromAppId]
 */
export function defaultVaultKeysForApp(appId, suffixFromAppId = true) {
  const slug = suffixFromAppId
    ? appId
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
    : "APP";
  return {
    client_id_key: `HDC_GCP_OAUTH_${slug}_CLIENT_ID`,
    client_secret_key: `HDC_GCP_OAUTH_${slug}_CLIENT_SECRET`,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeGcpOauthConfig(cfg) {
  const gcp = isObject(cfg.gcp) ? cfg.gcp : {};
  const projectId =
    typeof gcp.project_id === "string" && gcp.project_id.trim() ? gcp.project_id.trim() : "";
  let consoleUrl =
    typeof gcp.console_url === "string" && gcp.console_url.trim() ? gcp.console_url.trim() : "";
  if (!consoleUrl && projectId) {
    consoleUrl = `https://console.cloud.google.com/apis/credentials?project=${encodeURIComponent(projectId)}`;
  }

  const defaults = isObject(cfg.defaults) ? cfg.defaults : {};
  const defaultClientType =
    typeof defaults.client_type === "string" && defaults.client_type.trim()
      ? defaults.client_type.trim().toLowerCase()
      : "web";
  const vaultSuffixFromAppId = defaults.vault_id_suffix_from_app_id !== false;

  /** @type {ConfigApplication[]} */
  const applications = [];
  const appList = Array.isArray(cfg.applications) ? cfg.applications : [];
  for (const raw of appList) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) continue;
    const displayName =
      typeof raw.display_name === "string" && raw.display_name.trim()
        ? raw.display_name.trim()
        : id;
    const clientType =
      typeof raw.client_type === "string" && raw.client_type.trim()
        ? raw.client_type.trim().toLowerCase()
        : defaultClientType;

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

    const vaultRaw = isObject(raw.vault) ? raw.vault : {};
    const defaultVault = defaultVaultKeysForApp(id, vaultSuffixFromAppId);
    const clientIdKey =
      typeof vaultRaw.client_id_key === "string" && vaultRaw.client_id_key.trim()
        ? vaultRaw.client_id_key.trim()
        : defaultVault.client_id_key;
    const clientSecretKey =
      typeof vaultRaw.client_secret_key === "string" && vaultRaw.client_secret_key.trim()
        ? vaultRaw.client_secret_key.trim()
        : defaultVault.client_secret_key;

    const existingClientId =
      typeof raw.existing_client_id === "string" && raw.existing_client_id.trim()
        ? raw.existing_client_id.trim()
        : null;
    const importMatch =
      typeof raw.import_match === "string" && raw.import_match.trim()
        ? raw.import_match.trim()
        : null;

    /** @type {ConfigApplication} */
    const app = {
      id,
      display_name: displayName,
      client_type: clientType,
      redirect_uris: normalizeUriList(raw.redirect_uris),
      javascript_origins: normalizeUriList(raw.javascript_origins),
      scopes: normalizeUriList(raw.scopes),
      derive_from: deriveFrom,
      vault: { client_id_key: clientIdKey, client_secret_key: clientSecretKey },
      existing_client_id: existingClientId,
      import_match: importMatch,
    };
    applications.push(app);
  }

  return {
    projectId,
    consoleUrl,
    defaultClientType,
    vaultSuffixFromAppId,
    applications,
    applicationsById: new Map(applications.map((a) => [a.id, a])),
  };
}

/**
 * @param {ConfigApplication} app
 * @param {NormalizedImportClient[]} importClients
 * @returns {NormalizedImportClient | null}
 */
export function findImportForConfigApp(app, importClients) {
  if (app.existing_client_id) {
    const byId = importClients.find((c) => c.client_id === app.existing_client_id);
    if (byId) return byId;
  }
  if (app.import_match) {
    const needle = app.import_match.trim().toLowerCase();
    const byMatch = importClients.find(
      (c) =>
        c.client_id.toLowerCase() === needle ||
        (c.display_name && c.display_name.trim().toLowerCase() === needle)
    );
    if (byMatch) return byMatch;
  }
  const name = app.display_name.trim().toLowerCase();
  return (
    importClients.find((c) => c.display_name && c.display_name.trim().toLowerCase() === name) ??
    null
  );
}
