/** @typedef {{
 *   fulldomain: string;
 *   subdomain?: string | null;
 *   domain?: string;
 *   suffix?: string;
 *   dkim_selector?: string;
 *   dkim_verified?: boolean;
 *   dkim_status?: string;
 *   dkim_value?: string;
 *   rpath_selector?: string;
 *   rpath_verified?: boolean;
 *   rpath_status?: string;
 *   rpath_value?: string;
 * }} Smtp2goDomainRecord */

/** @typedef {{
 *   fulldomain?: string;
 *   subdomain?: string;
 *   domain?: string;
 *   suffix?: string;
 *   cname_verified?: boolean;
 *   cname_status?: string;
 *   cname_value?: string;
 *   enabled?: boolean;
 * }} Smtp2goTracker */

/** @typedef {{
 *   domain: Smtp2goDomainRecord;
 *   trackers?: Smtp2goTracker[];
 *   from_master?: boolean;
 * }} Smtp2goSenderDomainRow */

/** @typedef {{ ip_address?: string; description?: string }} Smtp2goIpAllowListEntry */

/** @typedef {{
 *   enabled?: boolean;
 *   ip_addresses?: Smtp2goIpAllowListEntry[];
 * }} Smtp2goIpAllowListState */

/** @typedef {{
 *   mode?: "whitelist" | "blacklist" | "disabled";
 *   allowed_senders?: string[];
 * }} Smtp2goAllowedSendersState */

/**
 * @param {unknown} body
 * @returns {string}
 */
export function smtp2goErrorMessage(body) {
  if (!body || typeof body !== "object") return "SMTP2GO API request failed";
  const b = /** @type {{ data?: { error?: string; error_code?: string }; error?: string }} */ (body);
  const parts = [];
  const err =
    (b.data && typeof b.data.error === "string" && b.data.error.trim()) ||
    (typeof b.error === "string" && b.error.trim()) ||
    "";
  if (err) {
    const code =
      b.data && typeof b.data.error_code === "string" && b.data.error_code.trim()
        ? ` (${b.data.error_code})`
        : "";
    parts.push(`${err}${code}`);
  }
  return parts.length ? parts.join("; ") : "SMTP2GO API request failed";
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.apiBaseUrl]
 */
export function createSmtp2goClient(opts) {
  const apiKey = opts.apiKey;
  const apiBaseUrl = (opts.apiBaseUrl ?? "https://api.smtp2go.com/v3").replace(/\/$/, "");

  /**
   * @param {string} path
   * @param {Record<string, unknown>} [body]
   */
  async function post(path, body = {}) {
    const url = `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Smtp2go-Api-Key": apiKey,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    let parsed = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`SMTP2GO API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
      }
    }
    if (!res.ok) {
      throw new Error(smtp2goErrorMessage(parsed) || `SMTP2GO API HTTP ${res.status}`);
    }
    if (parsed && typeof parsed === "object" && parsed.data && typeof parsed.data === "object") {
      const data = /** @type {{ error?: string }} */ (parsed.data);
      if (typeof data.error === "string" && data.error.trim()) {
        throw new Error(smtp2goErrorMessage(parsed));
      }
    }
    return parsed;
  }

  return {
    /**
     * @param {string} [domain]
     * @returns {Promise<Smtp2goSenderDomainRow[]>}
     */
    async listSenderDomains(domain) {
      /** @type {Record<string, string>} */
      const body = {};
      if (domain && domain.trim()) body.domain = domain.trim();
      const res = await post("/domain/view", body);
      const rows = res?.data?.domains;
      return Array.isArray(rows) ? rows : [];
    },

    /**
     * @param {object} opts
     * @param {string} opts.domain
     * @param {string} [opts.trackingSubdomain]
     * @param {string} [opts.returnpathSubdomain]
     * @param {boolean} [opts.autoVerify]
     * @returns {Promise<Smtp2goSenderDomainRow[]>}
     */
    async addSenderDomain(opts) {
      /** @type {Record<string, unknown>} */
      const body = { domain: opts.domain.trim() };
      if (opts.trackingSubdomain && opts.trackingSubdomain.trim()) {
        body.tracking_subdomain = opts.trackingSubdomain.trim();
      }
      if (opts.returnpathSubdomain && opts.returnpathSubdomain.trim()) {
        body.returnpath_subdomain = opts.returnpathSubdomain.trim();
      }
      if (opts.autoVerify === true) body.auto_verify = true;
      const res = await post("/domain/add", body);
      const rows = res?.data?.domains;
      return Array.isArray(rows) ? rows : [];
    },

    /**
     * @param {string} domain
     * @returns {Promise<Smtp2goSenderDomainRow[]>}
     */
    async verifySenderDomain(domain) {
      const res = await post("/domain/verify", { domain: domain.trim() });
      const rows = res?.data?.domains;
      return Array.isArray(rows) ? rows : [];
    },

    /**
     * @returns {Promise<Smtp2goIpAllowListState>}
     */
    async viewIpAllowList() {
      const res = await post("/ip_allow_list/view", {});
      const data = res?.data;
      if (!data || typeof data !== "object") {
        return { enabled: false, ip_addresses: [] };
      }
      return /** @type {Smtp2goIpAllowListState} */ (data);
    },

    /**
     * @param {boolean} enabled
     * @returns {Promise<Smtp2goIpAllowListState>}
     */
    async setIpAllowListEnabled(enabled) {
      const res = await post("/ip_allow_list", { enabled: enabled === true });
      const data = res?.data;
      if (!data || typeof data !== "object") {
        return { enabled: enabled === true, ip_addresses: [] };
      }
      return /** @type {Smtp2goIpAllowListState} */ (data);
    },

    /**
     * @param {object} opts
     * @param {string} opts.ip_address
     * @param {string} [opts.description]
     */
    async addIpAllowListEntry(opts) {
      /** @type {Record<string, string>} */
      const body = { ip_address: opts.ip_address.trim() };
      if (opts.description && opts.description.trim()) {
        body.description = opts.description.trim();
      }
      const res = await post("/ip_allow_list/add", body);
      return res?.data ?? null;
    },

    /**
     * @param {object} opts
     * @param {string} opts.ip_address
     * @param {string} [opts.new_ip_address]
     * @param {string} [opts.description]
     */
    async editIpAllowListEntry(opts) {
      /** @type {Record<string, string>} */
      const body = { ip_address: opts.ip_address.trim() };
      if (opts.new_ip_address && opts.new_ip_address.trim()) {
        body.new_ip_address = opts.new_ip_address.trim();
      }
      if (opts.description !== undefined) {
        body.description = opts.description.trim();
      }
      const res = await post("/ip_allow_list/edit", body);
      return res?.data ?? null;
    },

    /**
     * @param {string} ip_address
     */
    async removeIpAllowListEntry(ip_address) {
      const res = await post("/ip_allow_list/remove", { ip_address: ip_address.trim() });
      return res?.data ?? null;
    },

    /**
     * @returns {Promise<Smtp2goAllowedSendersState>}
     */
    async viewAllowedSenders() {
      const res = await post("/allowed_senders/view", {});
      const data = res?.data;
      if (!data || typeof data !== "object") {
        return { mode: "disabled", allowed_senders: [] };
      }
      return /** @type {Smtp2goAllowedSendersState} */ (data);
    },

    /**
     * @param {object} opts
     * @param {"whitelist" | "blacklist" | "disabled"} opts.mode
     * @param {string[]} opts.allowed_senders
     * @returns {Promise<Smtp2goAllowedSendersState>}
     */
    async updateAllowedSenders(opts) {
      const res = await post("/allowed_senders/update", {
        mode: opts.mode,
        allowed_senders: opts.allowed_senders,
      });
      const data = res?.data;
      if (!data || typeof data !== "object") {
        return { mode: opts.mode, allowed_senders: opts.allowed_senders };
      }
      return /** @type {Smtp2goAllowedSendersState} */ (data);
    },
  };
}
