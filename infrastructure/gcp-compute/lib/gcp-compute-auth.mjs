import { createSign } from "node:crypto";

/**
 * @typedef {{ client_email: string; private_key: string; project_id?: string }} ServiceAccountJson
 */

/**
 * @param {ServiceAccountJson} sa
 * @param {string} [scope]
 */
export function createGcpAccessTokenProvider(sa, scope = "https://www.googleapis.com/auth/cloud-platform") {
  const clientEmail = sa.client_email.trim();
  const privateKey = sa.private_key;

  /** @type {{ accessToken: string; expiresAt: number } | null} */
  let cache = null;

  /**
   * @returns {string}
   */
  function signJwt() {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claim = Buffer.from(
      JSON.stringify({
        iss: clientEmail,
        scope,
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    ).toString("base64url");
    const input = `${header}.${claim}`;
    const sign = createSign("RSA-SHA256");
    sign.update(input);
    sign.end();
    const sig = sign.sign(privateKey).toString("base64url");
    return `${input}.${sig}`;
  }

  return {
    /** @returns {Promise<string>} */
    async getAccessToken() {
      const now = Date.now();
      if (cache && cache.expiresAt > now + 60_000) return cache.accessToken;

      const assertion = signJwt();
      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      });

      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(60_000),
      });

      const text = await res.text();
      /** @type {{ access_token?: string; expires_in?: number; error?: string }} */
      let json = {};
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`GCP token endpoint returned non-JSON (${res.status})`);
        }
      }
      if (!res.ok || !json.access_token) {
        throw new Error(`GCP token request failed: ${json.error ?? `HTTP ${res.status}`}`);
      }
      const expiresIn =
        typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
      cache = { accessToken: json.access_token, expiresAt: now + expiresIn * 1000 };
      return cache.accessToken;
    },
  };
}

/**
 * @param {string} raw
 * @returns {ServiceAccountJson}
 */
export function parseServiceAccountJson(raw) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HDC_GCP_COMPUTE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("service account JSON must be an object");
  }
  const o = /** @type {Record<string, unknown>} */ (parsed);
  const client_email = typeof o.client_email === "string" ? o.client_email.trim() : "";
  const private_key = typeof o.private_key === "string" ? o.private_key : "";
  if (!client_email || !private_key) {
    throw new Error("service account JSON requires client_email and private_key");
  }
  return {
    client_email,
    private_key,
    project_id: typeof o.project_id === "string" ? o.project_id : undefined,
  };
}
