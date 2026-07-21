/**
 * Slack App Manifest API + config token rotation client.
 */

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} [opts.apiBase]
 * @param {typeof fetch} [opts.fetchFn]
 */
export function createSlackManifestClient(opts) {
  const apiBase = (opts.apiBase || "https://slack.com/api").replace(/\/$/, "");
  const token = String(opts.token ?? "").trim();
  const fetchFn = opts.fetchFn ?? fetch;

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [body]
   */
  async function call(method, body = {}) {
    const res = await fetchFn(`${apiBase}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      const err = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
      throw new Error(`Slack API ${method}: ${err}`);
    }
    return data;
  }

  return {
    /**
     * @param {Record<string, unknown>} manifest
     */
    async createApp(manifest) {
      return call("apps.manifest.create", { manifest });
    },
    /**
     * @param {string} appId
     * @param {Record<string, unknown>} manifest
     */
    async updateApp(appId, manifest) {
      return call("apps.manifest.update", { app_id: appId, manifest });
    },
    /**
     * @param {string} appId
     */
    async exportApp(appId) {
      return call("apps.manifest.export", { app_id: appId });
    },
    /**
     * @param {Record<string, unknown>} manifest
     */
    async validateManifest(manifest) {
      return call("apps.manifest.validate", { manifest });
    },
    /**
     * @param {string} appId
     * @param {string} filePath
     */
    async setAppIcon(appId, filePath) {
      const { readFileSync } = await import("node:fs");
      const { basename } = await import("node:path");
      const id = String(appId ?? "").trim();
      if (!id) throw new Error("app_id is required");
      const path = String(filePath ?? "").trim();
      if (!path) throw new Error("icon file path is required");
      const buf = readFileSync(path);
      const form = new FormData();
      form.append("app_id", id);
      const name = basename(path) || "icon.png";
      const type = name.toLowerCase().endsWith(".jpg") || name.toLowerCase().endsWith(".jpeg")
        ? "image/jpeg"
        : "image/png";
      form.append("file", new Blob([buf], { type }), name);
      const res = await fetchFn(`${apiBase}/apps.icon.set`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        const err = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
        throw new Error(`Slack API apps.icon.set: ${err}`);
      }
      return data;
    },
  };
}

/**
 * Rotate app configuration tokens (tooling.tokens.rotate).
 *
 * @param {object} opts
 * @param {string} opts.refreshToken
 * @param {string} [opts.apiBase]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<{ token: string, refresh_token: string, exp?: number }>}
 */
export async function rotateSlackConfigTokens(opts) {
  const apiBase = (opts.apiBase || "https://slack.com/api").replace(/\/$/, "");
  const refreshToken = String(opts.refreshToken ?? "").trim();
  if (!refreshToken) throw new Error("refresh token is required");
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${apiBase}/tooling.tokens.rotate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    const err = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
    throw new Error(`Slack tooling.tokens.rotate: ${err}`);
  }
  const token = typeof data.token === "string" ? data.token.trim() : "";
  const nextRefresh =
    typeof data.refresh_token === "string" ? data.refresh_token.trim() : "";
  if (!token) throw new Error("Slack tooling.tokens.rotate returned empty token");
  return {
    token,
    refresh_token: nextRefresh || refreshToken,
    exp: typeof data.exp === "number" ? data.exp : undefined,
  };
}
