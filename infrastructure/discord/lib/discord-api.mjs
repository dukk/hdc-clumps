/**
 * @typedef {{
 *   id: string;
 *   name: string;
 *   description: string | null;
 *   icon: string | null;
 *   redirect_uris?: string[];
 *   interactions_endpoint_url?: string | null;
 *   tags?: string[];
 *   bot_public?: boolean;
 *   bot_require_code_grant?: boolean;
 *   flags?: number;
 *   bot?: { id?: string; username?: string };
 * }} DiscordApplication
 */

/**
 * @param {unknown} body
 * @returns {string}
 */
function discordErrorMessage(body) {
  if (!body || typeof body !== "object") return "Discord API request failed";
  const b = /** @type {{ message?: string; code?: number }} */ (body);
  if (typeof b.message === "string" && b.message.trim()) {
    return b.code != null ? `${b.message.trim()} (code ${b.code})` : b.message.trim();
  }
  return "Discord API request failed";
}

/**
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string} [opts.apiBaseUrl]
 */
export function createDiscordClient(opts) {
  const botToken = opts.botToken.trim();
  const apiBaseUrl = (opts.apiBaseUrl ?? "https://discord.com/api/v10").replace(/\/$/, "");

  /**
   * @param {string} path
   * @param {{ method?: string; body?: Record<string, unknown> }} [req]
   */
  async function request(path, req = {}) {
    const url = `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      method: req.method ?? "GET",
      headers: {
        Authorization: `Bot ${botToken}`,
        Accept: "application/json",
        ...(req.body ? { "Content-Type": "application/json" } : {}),
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    let body = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 500) };
      }
    }
    if (!res.ok) {
      throw new Error(
        `Discord ${req.method ?? "GET"} ${path}: HTTP ${res.status} — ${discordErrorMessage(body)}`
      );
    }
    return body;
  }

  return {
    /**
     * @returns {Promise<DiscordApplication>}
     */
    async getCurrentApplication() {
      return /** @type {Promise<DiscordApplication>} */ (request("/applications/@me"));
    },

    /**
     * @param {Record<string, unknown>} patch
     * @returns {Promise<DiscordApplication>}
     */
    async patchCurrentApplication(patch) {
      return /** @type {Promise<DiscordApplication>} */ (
        request("/applications/@me", { method: "PATCH", body: patch })
      );
    },
  };
}
