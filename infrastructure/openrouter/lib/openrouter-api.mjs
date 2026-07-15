/** @typedef {{ total_credits: number; total_usage: number }} OpenrouterCredits */

/**
 * @typedef {{
 *   hash: string;
 *   name: string;
 *   label?: string;
 *   limit: number | null;
 *   limit_remaining: number | null;
 *   limit_reset: string | null;
 *   include_byok_in_limit: boolean;
 *   disabled?: boolean;
 *   usage: number;
 *   usage_daily: number;
 *   usage_weekly: number;
 *   usage_monthly: number;
 * }} OpenrouterApiKeyRow
 */

/** @typedef {OpenrouterApiKeyRow & { key?: string }} OpenrouterCreateKeyResponse */

/**
 * @param {unknown} body
 * @returns {string}
 */
function openrouterErrorMessage(body) {
  if (!body || typeof body !== "object") return "OpenRouter API request failed";
  const b = /** @type {{ error?: { message?: string; code?: number }; message?: string }} */ (body);
  if (b.error && typeof b.error === "object") {
    const msg = typeof b.error.message === "string" ? b.error.message.trim() : "";
    const code = b.error.code;
    if (msg) return code != null ? `${msg} (code ${code})` : msg;
  }
  if (typeof b.message === "string" && b.message.trim()) return b.message.trim();
  return "OpenRouter API request failed";
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.apiBaseUrl]
 */
export function createOpenrouterClient(opts) {
  const apiKey = opts.apiKey;
  const apiBaseUrl = (opts.apiBaseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

  /**
   * @param {string} path
   * @param {{ method?: string; body?: Record<string, unknown>; authKey?: string }} [req]
   */
  async function request(path, req = {}) {
    const authKey = req.authKey ?? apiKey;
    const url = `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      method: req.method ?? "GET",
      headers: {
        Authorization: `Bearer ${authKey}`,
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
        `OpenRouter ${req.method ?? "GET"} ${path}: HTTP ${res.status} — ${openrouterErrorMessage(body)}`
      );
    }
    return body;
  }

  return {
    apiBaseUrl,

    /** @returns {Promise<OpenrouterCredits>} */
    async getCredits() {
      const body = await request("/credits");
      const data =
        body && typeof body === "object" && "data" in body ? /** @type {{ data?: Record<string, unknown> }} */ (body).data : null;
      const totalCredits = Number(data?.total_credits ?? data?.total_credits_purchased ?? 0);
      const totalUsage = Number(data?.total_usage ?? 0);
      return {
        total_credits: Number.isFinite(totalCredits) ? totalCredits : 0,
        total_usage: Number.isFinite(totalUsage) ? totalUsage : 0,
      };
    },

    /** @returns {Promise<OpenrouterApiKeyRow[]>} */
    async listKeys() {
      const body = await request("/keys");
      const data = body && typeof body === "object" && "data" in body ? /** @type {{ data?: unknown[] }} */ (body).data : [];
      if (!Array.isArray(data)) return [];
      return data
        .map((row) => normalizeKeyRow(row))
        .filter((row) => row.hash);
    },

    /**
     * Per-key usage via inference key auth.
     * @param {string} inferenceApiKey
     */
    async getKeyStats(inferenceApiKey) {
      const body = await request("/key", { authKey: inferenceApiKey });
      const data =
        body && typeof body === "object" && "data" in body ? /** @type {{ data?: Record<string, unknown> }} */ (body).data : null;
      if (!data) return null;
      return normalizeKeyRow(data);
    },

    /**
     * @param {object} payload
     * @param {string} payload.name
     * @param {number | null} [payload.limit]
     * @param {string | null} [payload.limit_reset]
     * @param {boolean} [payload.include_byok_in_limit]
     * @param {boolean} [payload.disabled]
     * @returns {Promise<OpenrouterCreateKeyResponse>}
     */
    async createKey(payload) {
      const body = await request("/keys", {
        method: "POST",
        body: {
          name: payload.name,
          ...(payload.limit != null ? { limit: payload.limit } : {}),
          ...(payload.limit_reset != null ? { limit_reset: payload.limit_reset } : {}),
          include_byok_in_limit: payload.include_byok_in_limit === true,
          ...(payload.disabled != null ? { disabled: payload.disabled } : {}),
        },
      });
      const data =
        body && typeof body === "object" && "data" in body ? /** @type {{ data?: Record<string, unknown> }} */ (body).data : null;
      if (!data) throw new Error("OpenRouter create key: empty response data");
      const row = normalizeKeyRow(data);
      const key = typeof data.key === "string" ? data.key : undefined;
      return { ...row, key };
    },

    /**
     * @param {string} hash
     * @param {object} payload
     */
    async updateKey(hash, payload) {
      const body = await request(`/keys/${encodeURIComponent(hash)}`, {
        method: "PATCH",
        body: {
          ...(payload.name != null ? { name: payload.name } : {}),
          ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
          ...(payload.limit_reset !== undefined ? { limit_reset: payload.limit_reset } : {}),
          ...(payload.include_byok_in_limit !== undefined
            ? { include_byok_in_limit: payload.include_byok_in_limit }
            : {}),
          ...(payload.disabled !== undefined ? { disabled: payload.disabled } : {}),
        },
      });
      const data =
        body && typeof body === "object" && "data" in body ? /** @type {{ data?: Record<string, unknown> }} */ (body).data : null;
      return data ? normalizeKeyRow(data) : normalizeKeyRow({ hash, name: payload.name ?? "" });
    },

    /** @param {string} hash */
    async deleteKey(hash) {
      await request(`/keys/${encodeURIComponent(hash)}`, { method: "DELETE" });
      return { ok: true, hash };
    },
  };
}

/**
 * @param {unknown} row
 * @returns {OpenrouterApiKeyRow}
 */
export function normalizeKeyRow(row) {
  const r = row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : {};
  const hash = typeof r.hash === "string" ? r.hash.trim() : "";
  const name =
    typeof r.name === "string" && r.name.trim()
      ? r.name.trim()
      : typeof r.label === "string" && r.label.trim()
        ? r.label.trim()
        : "";
  const limit = r.limit === null || r.limit === undefined ? null : Number(r.limit);
  const limitRemaining =
    r.limit_remaining === null || r.limit_remaining === undefined
      ? null
      : Number(r.limit_remaining);
  const limitReset =
    typeof r.limit_reset === "string" && r.limit_reset.trim() ? r.limit_reset.trim() : null;
  const includeByok = r.include_byok_in_limit === true;
  const disabled = r.disabled === true;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    hash,
    name,
    label: typeof r.label === "string" ? r.label : undefined,
    limit: Number.isFinite(limit) ? limit : null,
    limit_remaining: Number.isFinite(limitRemaining) ? limitRemaining : null,
    limit_reset: limitReset,
    include_byok_in_limit: includeByok,
    disabled,
    usage: num(r.usage),
    usage_daily: num(r.usage_daily),
    usage_weekly: num(r.usage_weekly),
    usage_monthly: num(r.usage_monthly),
  };
}
