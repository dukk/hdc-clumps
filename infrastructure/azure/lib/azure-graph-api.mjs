/** @typedef {{ id: string; appId: string; displayName: string; signInAudience?: string; web?: { redirectUris?: string[] }; spa?: { redirectUris?: string[] }; publicClient?: { redirectUris?: string[] }; requiredResourceAccess?: GraphRequiredResourceAccess[]; identifierUris?: string[] }} GraphApplication */

/** @typedef {{ resourceAppId: string; resourceAccess: { id: string; type: string }[] }} GraphRequiredResourceAccess */

/**
 * @param {unknown} body
 * @returns {string}
 */
function graphErrorMessage(body) {
  if (!body || typeof body !== "object") return "Microsoft Graph request failed";
  const b = /** @type {{ error?: { message?: string; code?: string } }} */ (body);
  if (b.error && typeof b.error.message === "string" && b.error.message.trim()) {
    return b.error.code ? `${b.error.message} (${b.error.code})` : b.error.message;
  }
  return "Microsoft Graph request failed";
}

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getAccessToken
 * @param {string} [opts.baseUrl]
 */
export function createAzureGraphClient(opts) {
  const baseUrl = (opts.baseUrl ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
  const getAccessToken = opts.getAccessToken;

  /**
   * @param {string} pathOrUrl
   * @param {{ method?: string; query?: Record<string, string>; body?: unknown }} [req]
   */
  async function request(pathOrUrl, req = {}) {
    const url = pathOrUrl.startsWith("http")
      ? new URL(pathOrUrl)
      : new URL(`${baseUrl}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }
    const token = await getAccessToken();
    const res = await fetch(url, {
      method: req.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    let body = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Microsoft Graph returned non-JSON (${res.status})`);
      }
    }
    if (!res.ok) {
      throw new Error(graphErrorMessage(body) || `HTTP ${res.status}`);
    }
    return /** @type {Record<string, unknown>} */ (body ?? {});
  }

  /**
   * @param {string} path
   * @param {Record<string, string>} [query]
   */
  async function listAll(path, query = {}) {
    /** @type {unknown[]} */
    const items = [];
    let next = /** @type {string | null} */ (
      `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`
    );
    const firstQuery = { ...query };
    let first = true;
    while (next) {
      const res = first
        ? await request(path, { query: firstQuery })
        : await request(next);
      first = false;
      const chunk = Array.isArray(res.value) ? res.value : [];
      items.push(...chunk);
      const link = typeof res["@odata.nextLink"] === "string" ? res["@odata.nextLink"] : null;
      next = link;
    }
    return items;
  }

  /**
   * @param {unknown} row
   * @returns {GraphApplication}
   */
  function parseApplication(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    return {
      id: String(r.id ?? ""),
      appId: String(r.appId ?? ""),
      displayName: String(r.displayName ?? ""),
      signInAudience: typeof r.signInAudience === "string" ? r.signInAudience : undefined,
      web: /** @type {GraphApplication["web"]} */ (r.web),
      spa: /** @type {GraphApplication["spa"]} */ (r.spa),
      publicClient: /** @type {GraphApplication["publicClient"]} */ (r.publicClient),
      requiredResourceAccess: Array.isArray(r.requiredResourceAccess)
        ? /** @type {GraphRequiredResourceAccess[]} */ (r.requiredResourceAccess)
        : [],
      identifierUris: Array.isArray(r.identifierUris)
        ? r.identifierUris.map((u) => String(u))
        : [],
    };
  }

  const appSelect =
    "id,appId,displayName,signInAudience,web,spa,publicClient,requiredResourceAccess,identifierUris";

  return {
    /**
     * @returns {Promise<GraphApplication[]>}
     */
    async listApplications() {
      const raw = await listAll("/applications", { $select: appSelect, $top: "999" });
      return raw.map(parseApplication).filter((a) => a.id && a.appId);
    },

    /**
     * @param {Record<string, unknown>} body
     * @returns {Promise<GraphApplication>}
     */
    async createApplication(body) {
      const res = await request("/applications", { method: "POST", body });
      return parseApplication(res);
    },

    /**
     * @param {string} objectId
     * @param {Record<string, unknown>} body
     */
    async patchApplication(objectId, body) {
      await request(`/applications/${encodeURIComponent(objectId)}`, {
        method: "PATCH",
        body,
      });
    },

    /**
     * @param {string} appId Client ID (appId field)
     * @returns {Promise<{ id: string; appId: string } | null>}
     */
    async findServicePrincipalByAppId(appId) {
      const res = await request("/servicePrincipals", {
        query: { $filter: `appId eq '${appId.replace(/'/g, "''")}'`, $select: "id,appId" },
      });
      const rows = Array.isArray(res.value) ? res.value : [];
      if (!rows.length) return null;
      const row = /** @type {{ id?: string; appId?: string }} */ (rows[0]);
      return { id: String(row.id ?? ""), appId: String(row.appId ?? appId) };
    },

    /**
     * @param {string} appId Client ID
     * @returns {Promise<{ id: string; appId: string }>}
     */
    async ensureServicePrincipal(appId) {
      const existing = await this.findServicePrincipalByAppId(appId);
      if (existing?.id) return existing;
      const res = await request("/servicePrincipals", {
        method: "POST",
        body: { appId },
      });
      const row = /** @type {{ id?: string; appId?: string }} */ (res);
      return { id: String(row.id ?? ""), appId: String(row.appId ?? appId) };
    },
  };
}
