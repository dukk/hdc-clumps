/** @typedef {{
 *   email?: string;
 *   monitor_limit?: number;
 *   monitor_interval?: number;
 *   up_monitors?: number;
 *   down_monitors?: number;
 *   pause_monitors?: number;
 * }} UptimerobotAccount */

/** @typedef {{
 *   id: number | string;
 *   friendly_name?: string;
 *   url?: string;
 *   type?: number | string;
 *   sub_type?: number | string;
 *   keyword_type?: number | string;
 *   keyword_case_type?: number | string;
 *   keyword_value?: string;
 *   http_username?: string;
 *   http_password?: string;
 *   http_auth_type?: number | string;
 *   port?: number | string;
 *   interval?: number | string;
 *   status?: number | string;
 *   alert_contacts?: unknown;
 *   ignore_ssl_errors?: number | string;
 *   custom_http_statuses?: string;
 *   http_method?: number | string;
 * }} UptimerobotMonitorRow */

/** @typedef {{
 *   id: number | string;
 *   friendly_name?: string;
 *   type?: number | string;
 *   status?: number | string;
 *   value?: string;
 * }} UptimerobotAlertContactRow */

/** @typedef {{
 *   id: number | string;
 *   friendly_name?: string;
 *   monitors?: number | string;
 *   sort?: number | string;
 *   status?: number | string;
 *   standard_url?: string;
 *   custom_url?: string;
 *   custom_domain?: string;
 *   hide_url_links?: boolean | number | string;
 * }} UptimerobotPspRow */

const DEFAULT_MIN_DELAY_MS = 6500;

/**
 * @param {unknown} body
 * @returns {string}
 */
export function uptimerobotErrorMessage(body) {
  if (!body || typeof body !== "object") return "UptimeRobot API request failed";
  const b = /** @type {{ stat?: string; error?: { type?: string; message?: string; parameter_name?: string } }} */ (
    body
  );
  if (b.stat === "ok") return "UptimeRobot API request failed";
  const err = b.error;
  if (err && typeof err === "object") {
    const parts = [];
    if (typeof err.type === "string" && err.type.trim()) parts.push(err.type);
    if (typeof err.message === "string" && err.message.trim()) parts.push(err.message);
    if (typeof err.parameter_name === "string" && err.parameter_name.trim()) {
      parts.push(`parameter: ${err.parameter_name}`);
    }
    if (parts.length) return parts.join(": ");
  }
  return "UptimeRobot API request failed";
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.apiBaseUrl]
 * @param {number} [opts.minDelayMs]
 */
export function createUptimerobotClient(opts) {
  const apiKey = opts.apiKey;
  const apiBaseUrl = (opts.apiBaseUrl ?? "https://api.uptimerobot.com/v2").replace(/\/$/, "");
  const minDelayMs = opts.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
  /** @type {number | null} */
  let lastRequestAt = null;

  /**
   * @param {string} method
   * @param {Record<string, string | number | boolean | undefined | null>} [fields]
   */
  async function post(method, fields = {}) {
    if (lastRequestAt != null) {
      const elapsed = Date.now() - lastRequestAt;
      if (elapsed < minDelayMs) {
        await sleep(minDelayMs - elapsed);
      }
    }

    const body = new URLSearchParams();
    body.set("api_key", apiKey);
    body.set("format", "json");
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === "") continue;
      body.set(key, String(value));
    }

    let res;
    let attempt = 0;
    while (true) {
      lastRequestAt = Date.now();
      res = await fetch(`${apiBaseUrl}/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(120_000),
      });

      if (res.status !== 429 || attempt >= 3) break;
      attempt += 1;
      await sleep(minDelayMs * attempt);
    }

    let parsed = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`UptimeRobot API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
      }
    }

    if (!res.ok) {
      throw new Error(
        `UptimeRobot API HTTP ${res.status}: ${uptimerobotErrorMessage(parsed) || text.slice(0, 200)}`
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("UptimeRobot API returned empty response");
    }
    if (/** @type {{ stat?: string }} */ (parsed).stat !== "ok") {
      throw new Error(uptimerobotErrorMessage(parsed));
    }
    return parsed;
  }

  /**
   * @param {string} method
   * @param {string} arrayKey
   * @param {Record<string, string | number | boolean | undefined | null>} [extraFields]
   */
  async function listAll(method, arrayKey, extraFields = {}) {
    /** @type {unknown[]} */
    const rows = [];
    let offset = 0;
    const limit = 50;
    let total = Infinity;

    while (offset < total) {
      const resp = await post(method, { ...extraFields, offset, limit });
      const pagination =
        resp.pagination && typeof resp.pagination === "object"
          ? resp.pagination
          : { offset: resp.offset, limit: resp.limit, total: resp.total };
      const batch = Array.isArray(resp[arrayKey]) ? resp[arrayKey] : [];
      rows.push(...batch);
      total =
        typeof pagination?.total === "number"
          ? pagination.total
          : typeof resp.total === "number"
            ? resp.total
            : offset + batch.length;
      if (batch.length === 0) break;
      offset += batch.length;
      if (batch.length < limit) break;
    }

    return rows;
  }

  return {
    post,
    async getAccountDetails() {
      const resp = await post("getAccountDetails");
      const account =
        resp.account && typeof resp.account === "object"
          ? /** @type {UptimerobotAccount} */ (resp.account)
          : {};
      return account;
    },
    async listMonitors(extraFields = {}) {
      return /** @type {Promise<UptimerobotMonitorRow[]>} */ (
        listAll("getMonitors", "monitors", { alert_contacts: 1, ...extraFields })
      );
    },
    async listPsps() {
      return /** @type {Promise<UptimerobotPspRow[]>} */ (listAll("getPSPs", "psps"));
    },
    async listAlertContacts() {
      return /** @type {Promise<UptimerobotAlertContactRow[]>} */ (
        listAll("getAlertContacts", "alert_contacts")
      );
    },
    async newMonitor(fields) {
      return post("newMonitor", fields);
    },
    async editMonitor(fields) {
      return post("editMonitor", fields);
    },
    async deleteMonitor(id) {
      return post("deleteMonitor", { id });
    },
    async newPsp(fields) {
      return post("newPSP", fields);
    },
    async editPsp(fields) {
      return post("editPSP", fields);
    },
    async deletePsp(id) {
      return post("deletePSP", { id });
    },
    async newAlertContact(fields) {
      return post("newAlertContact", fields);
    },
    async editAlertContact(fields) {
      return post("editAlertContact", fields);
    },
    async deleteAlertContact(id) {
      return post("deleteAlertContact", { id });
    },
  };
}
