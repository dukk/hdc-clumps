/** @typedef {{ sid: string; friendly_name?: string; status?: string }} TwilioAccount */

/** @typedef {{ sid: string; friendly_name?: string; domain_name: string; disaster_recovery_url?: string | null }} TwilioTrunk */

/** @typedef {{ sid: string; friendly_name?: string; sip_url: string; priority: number; weight: number; enabled: boolean }} TwilioOriginationUrl */

/** @typedef {{ sid: string; phone_number: string }} TwilioTrunkPhoneNumber */

/** @typedef {{ sid: string; friendly_name?: string }} TwilioCredentialListRef */

/** @typedef {{ sid: string; username: string }} TwilioCredential */

/** @typedef {{ sid: string; phone_number: string; friendly_name?: string; voice_url?: string; sms_url?: string; trunk_sid?: string | null; capabilities?: Record<string, boolean> }} TwilioIncomingPhoneNumber */

/**
 * @param {unknown} body
 * @returns {string}
 */
function twilioErrorMessage(body) {
  if (!body || typeof body !== "object") return "Twilio API request failed";
  const b = /** @type {{ message?: string; more_info?: string; code?: number }} */ (body);
  const parts = [];
  if (typeof b.message === "string" && b.message.trim()) {
    parts.push(b.code != null ? `${b.message} (code ${b.code})` : b.message);
  }
  if (typeof b.more_info === "string" && b.more_info.trim()) {
    parts.push(b.more_info);
  }
  return parts.length ? parts.join("; ") : "Twilio API request failed";
}

/**
 * @param {string} accountSid
 * @param {string} authToken
 */
export function twilioBasicAuthHeader(accountSid, authToken) {
  const encoded = Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/**
 * @param {object} opts
 * @param {string} opts.accountSid
 * @param {string} opts.authToken
 * @param {string} [opts.apiBaseUrl]
 * @param {string} [opts.trunkingApiBaseUrl]
 */
export function createTwilioClient(opts) {
  const accountSid = opts.accountSid;
  const authToken = opts.authToken;
  const apiBaseUrl = (opts.apiBaseUrl ?? "https://api.twilio.com").replace(/\/$/, "");
  const trunkingApiBaseUrl = (opts.trunkingApiBaseUrl ?? "https://trunking.twilio.com").replace(
    /\/$/,
    ""
  );
  const authHeader = twilioBasicAuthHeader(accountSid, authToken);

  /**
   * @param {string} baseUrl
   * @param {string} path
   * @param {{ method?: string; query?: Record<string, string> }} [req]
   */
  async function request(baseUrl, path, req = {}) {
    const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url, {
      method: req.method ?? "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(120_000),
    });
    let body = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Twilio API returned non-JSON (${res.status})`);
      }
    }
    if (!res.ok) {
      throw new Error(twilioErrorMessage(body) || `HTTP ${res.status}`);
    }
    return /** @type {Record<string, unknown>} */ (body ?? {});
  }

  /**
   * Paginate Twilio REST API (next_page_uri) or Trunking API (meta.next_page_url).
   * @param {string} baseUrl
   * @param {string} firstPath
   * @param {string} collectionKey
   */
  async function listAllRest(baseUrl, firstPath, collectionKey) {
    /** @type {unknown[]} */
    const items = [];
    let path = firstPath;
    for (;;) {
      const body = await request(baseUrl, path);
      const chunk = Array.isArray(body[collectionKey]) ? body[collectionKey] : [];
      items.push(...chunk);
      const nextUri =
        typeof body.next_page_uri === "string" && body.next_page_uri.trim()
          ? body.next_page_uri.trim()
          : null;
      if (!nextUri) break;
      path = nextUri.startsWith("http") ? new URL(nextUri).pathname + new URL(nextUri).search : nextUri;
    }
    return items;
  }

  /**
   * @param {string} firstPath
   * @param {string} collectionKey
   */
  async function listAllTrunking(firstPath, collectionKey) {
    /** @type {unknown[]} */
    const items = [];
    let url = `${trunkingApiBaseUrl}${firstPath.startsWith("/") ? firstPath : `/${firstPath}`}`;
    for (;;) {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: authHeader, Accept: "application/json" },
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      let body = /** @type {Record<string, unknown>} */ ({});
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`Twilio Trunking API returned non-JSON (${res.status})`);
        }
      }
      if (!res.ok) {
        throw new Error(twilioErrorMessage(body) || `HTTP ${res.status}`);
      }
      const chunk = Array.isArray(body[collectionKey]) ? body[collectionKey] : [];
      items.push(...chunk);
      const meta = body.meta && typeof body.meta === "object" ? body.meta : null;
      const nextUrl =
        meta &&
        typeof /** @type {{ next_page_url?: string }} */ (meta).next_page_url === "string" &&
        /** @type {{ next_page_url?: string }} */ (meta).next_page_url.trim()
          ? /** @type {{ next_page_url: string }} */ (meta).next_page_url.trim()
          : null;
      if (!nextUrl) break;
      url = nextUrl;
    }
    return items;
  }

  return {
    accountSid,

    async getAccount() {
      const body = await request(
        apiBaseUrl,
        `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`
      );
      return /** @type {TwilioAccount} */ ({
        sid: String(body.sid ?? accountSid),
        friendly_name: typeof body.friendly_name === "string" ? body.friendly_name : undefined,
        status: typeof body.status === "string" ? body.status : undefined,
      });
    },

    async listIncomingPhoneNumbers() {
      const rows = await listAllRest(
        apiBaseUrl,
        `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers.json`,
        "incoming_phone_numbers"
      );
      return rows.map((row) => {
        const r = /** @type {Record<string, unknown>} */ (row);
        /** @type {Record<string, boolean>} */
        const capabilities = {};
        if (r.capabilities && typeof r.capabilities === "object") {
          const c = /** @type {Record<string, unknown>} */ (r.capabilities);
          for (const k of ["voice", "sms", "mms", "fax"]) {
            if (typeof c[k] === "boolean") capabilities[k] = c[k];
          }
        }
        return /** @type {TwilioIncomingPhoneNumber} */ ({
          sid: String(r.sid ?? ""),
          phone_number: String(r.phone_number ?? ""),
          friendly_name: typeof r.friendly_name === "string" ? r.friendly_name : undefined,
          voice_url: typeof r.voice_url === "string" ? r.voice_url : undefined,
          sms_url: typeof r.sms_url === "string" ? r.sms_url : undefined,
          trunk_sid:
            typeof r.trunk_sid === "string" && r.trunk_sid.trim() ? r.trunk_sid.trim() : null,
          capabilities: Object.keys(capabilities).length ? capabilities : undefined,
        });
      });
    },

    async listTrunks() {
      const rows = await listAllTrunking("/v1/Trunks", "trunks");
      return rows.map((row) => {
        const r = /** @type {Record<string, unknown>} */ (row);
        return /** @type {TwilioTrunk} */ ({
          sid: String(r.sid ?? ""),
          friendly_name: typeof r.friendly_name === "string" ? r.friendly_name : undefined,
          domain_name: String(r.domain_name ?? ""),
          disaster_recovery_url:
            typeof r.disaster_recovery_url === "string" ? r.disaster_recovery_url : null,
        });
      });
    },

    /**
     * @param {string} trunkSid
     */
    async listOriginationUrls(trunkSid) {
      const rows = await listAllTrunking(
        `/v1/Trunks/${encodeURIComponent(trunkSid)}/OriginationUrls`,
        "origination_urls"
      );
      return rows.map((row) => {
        const r = /** @type {Record<string, unknown>} */ (row);
        return /** @type {TwilioOriginationUrl} */ ({
          sid: String(r.sid ?? ""),
          friendly_name: typeof r.friendly_name === "string" ? r.friendly_name : undefined,
          sip_url: String(r.sip_url ?? ""),
          priority: Number(r.priority ?? 0),
          weight: Number(r.weight ?? 0),
          enabled: r.enabled !== false,
        });
      });
    },

    /**
     * @param {string} trunkSid
     */
    async listTrunkPhoneNumbers(trunkSid) {
      const rows = await listAllTrunking(
        `/v1/Trunks/${encodeURIComponent(trunkSid)}/PhoneNumbers`,
        "phone_numbers"
      );
      return rows.map((row) => {
        const r = /** @type {Record<string, unknown>} */ (row);
        return /** @type {TwilioTrunkPhoneNumber} */ ({
          sid: String(r.sid ?? ""),
          phone_number: String(r.phone_number ?? ""),
        });
      });
    },

    /**
     * @param {string} trunkSid
     */
    async listTrunkCredentialLists(trunkSid) {
      const rows = await listAllTrunking(
        `/v1/Trunks/${encodeURIComponent(trunkSid)}/CredentialLists`,
        "credential_lists"
      );
      return rows.map((row) => {
        const r = /** @type {Record<string, unknown>} */ (row);
        return /** @type {TwilioCredentialListRef} */ ({
          sid: String(r.sid ?? ""),
          friendly_name: typeof r.friendly_name === "string" ? r.friendly_name : undefined,
        });
      });
    },

    /**
     * @param {string} credentialListSid
     */
    async listCredentials(credentialListSid) {
      const rows = await listAllRest(
        apiBaseUrl,
        `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/SIP/CredentialLists/${encodeURIComponent(credentialListSid)}/Credentials.json`,
        "credentials"
      );
      return rows.map((row) => {
        const r = /** @type {Record<string, unknown>} */ (row);
        return /** @type {TwilioCredential} */ ({
          sid: String(r.sid ?? ""),
          username: String(r.username ?? ""),
        });
      });
    },
  };
}
