/** @typedef {{ id: string; script: string; pattern: string; zone_id?: string }} CfWorkerRoute */

/** @typedef {{ name: string }} CfWorkerSecret */

/** @typedef {{ id: string; name: string; created_on?: string; modified_on?: string }} CfWorkerScript */

/** @typedef {{ id: string; name: string; subdomain?: string; domains?: string[]; created_on?: string }} CfPagesProject */

/**
 * @param {unknown} body
 * @returns {string}
 */
function cloudflareErrorMessage(body) {
  if (!body || typeof body !== "object") return "Cloudflare API request failed";
  const b = /** @type {{ errors?: { message?: string; code?: number }[]; messages?: string[] }} */ (body);
  const parts = [];
  if (Array.isArray(b.errors)) {
    for (const e of b.errors) {
      if (e && typeof e.message === "string" && e.message.trim()) {
        parts.push(e.code != null ? `${e.message} (code ${e.code})` : e.message);
      }
    }
  }
  if (!parts.length && Array.isArray(b.messages)) {
    for (const m of b.messages) {
      if (typeof m === "string" && m.trim()) parts.push(m);
    }
  }
  return parts.length ? parts.join("; ") : "Cloudflare API request failed";
}

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.accountId
 * @param {string} [opts.baseUrl]
 */
export function createCloudflareWorkersClient(opts) {
  const baseUrl = (opts.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  const token = opts.token;
  const accountId = opts.accountId.trim();

  /**
   * @param {string} path
   * @param {{ method?: string; query?: Record<string, string>; body?: unknown }} [req]
   */
  async function request(path, req = {}) {
    const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }
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
        throw new Error(`Cloudflare API returned non-JSON (${res.status})`);
      }
    }
    if (!res.ok || (body && typeof body === "object" && body.success === false)) {
      throw new Error(cloudflareErrorMessage(body) || `HTTP ${res.status}`);
    }
    return /** @type {{ success?: boolean; result?: unknown; result_info?: { page: number; per_page: number; total_pages: number } }} */ (
      body ?? {}
    );
  }

  /**
   * @param {string} path
   * @param {Record<string, string>} [query]
   */
  async function listAll(path, query = {}) {
    /** @type {unknown[]} */
    const items = [];
    let page = 1;
    for (;;) {
      const res = await request(path, {
        query: { ...query, page: String(page), per_page: "100" },
      });
      const chunk = Array.isArray(res.result) ? res.result : [];
      items.push(...chunk);
      const info = res.result_info;
      if (!info || page >= info.total_pages) break;
      page += 1;
    }
    return items;
  }

  const accountPath = `/accounts/${encodeURIComponent(accountId)}`;

  return {
    accountId,

    /**
     * @returns {Promise<CfWorkerScript[]>}
     */
    async listWorkerScripts() {
      const raw = await listAll(`${accountPath}/workers/scripts`);
      return raw.map((r) => {
        const row = /** @type {{ id?: string; created_on?: string; modified_on?: string }} */ (r);
        const name = String(row.id ?? "");
        return {
          id: name,
          name,
          created_on: row.created_on,
          modified_on: row.modified_on,
        };
      });
    },

    /**
     * @param {string} scriptName
     * @returns {Promise<boolean>}
     */
    async workerScriptExists(scriptName) {
      try {
        await request(`${accountPath}/workers/scripts/${encodeURIComponent(scriptName)}`);
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found|10007|8000007/i.test(msg)) return false;
        throw e;
      }
    },

    /**
     * @param {string} zoneId
     * @returns {Promise<CfWorkerRoute[]>}
     */
    async listWorkerRoutes(zoneId) {
      const raw = await listAll(`/zones/${encodeURIComponent(zoneId)}/workers/routes`);
      return raw.map((r) => {
        const row = /** @type {{ id?: string; pattern?: string; script?: string }} */ (r);
        return {
          id: String(row.id ?? ""),
          pattern: String(row.pattern ?? ""),
          script: String(row.script ?? ""),
          zone_id: zoneId,
        };
      });
    },

    /**
     * @param {string} zoneId
     * @param {{ pattern: string; script: string }} body
     */
    async createWorkerRoute(zoneId, body) {
      const res = await request(`/zones/${encodeURIComponent(zoneId)}/workers/routes`, {
        method: "POST",
        body,
      });
      const row = /** @type {{ id?: string }} */ (res.result ?? {});
      return String(row.id ?? "");
    },

    /**
     * @param {string} zoneId
     * @param {string} routeId
     */
    async deleteWorkerRoute(zoneId, routeId) {
      await request(
        `/zones/${encodeURIComponent(zoneId)}/workers/routes/${encodeURIComponent(routeId)}`,
        { method: "DELETE" }
      );
    },

    /**
     * @param {string} scriptName
     * @returns {Promise<CfWorkerSecret[]>}
     */
    async listWorkerSecrets(scriptName) {
      const raw = await listAll(
        `${accountPath}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`
      );
      return raw.map((r) => {
        const row = /** @type {{ name?: string }} */ (r);
        return { name: String(row.name ?? "") };
      });
    },

    /**
     * @param {string} scriptName
     * @param {{ name: string; text: string }} body
     */
    async putWorkerSecret(scriptName, body) {
      await request(
        `${accountPath}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
        {
          method: "PUT",
          body: { name: body.name, text: body.text, type: "secret_text" },
        }
      );
    },

    /**
     * @param {string} scriptName
     * @param {string} secretName
     */
    async deleteWorkerSecret(scriptName, secretName) {
      await request(
        `${accountPath}/workers/scripts/${encodeURIComponent(scriptName)}/secrets/${encodeURIComponent(secretName)}`,
        { method: "DELETE" }
      );
    },

    /**
     * @returns {Promise<CfPagesProject[]>}
     */
    async listPagesProjects() {
      const raw = await listAll(`${accountPath}/pages/projects`);
      return raw.map((r) => {
        const row = /** @type {{ id?: string; name?: string; subdomain?: string; domains?: string[]; created_on?: string }} */ (
          r
        );
        return {
          id: String(row.id ?? ""),
          name: String(row.name ?? ""),
          subdomain: row.subdomain,
          domains: Array.isArray(row.domains) ? row.domains : undefined,
          created_on: row.created_on,
        };
      });
    },

    /**
     * @param {string} projectName
     * @returns {Promise<boolean>}
     */
    async pagesProjectExists(projectName) {
      try {
        await request(`${accountPath}/pages/projects/${encodeURIComponent(projectName)}`);
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found|8000007|1436/i.test(msg)) return false;
        throw e;
      }
    },
  };
}
