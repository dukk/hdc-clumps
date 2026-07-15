/**
 * OAuth2 client credentials for Azure Resource Manager.
 */
export function createAzureArmTokenProvider(opts) {
  const tenantId = opts.tenantId.trim();
  const clientId = opts.clientId.trim();
  const clientSecret = opts.clientSecret.trim();
  const scope = (opts.scope ?? "https://management.azure.com/.default").trim();
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

  /** @type {{ accessToken: string; expiresAt: number } | null} */
  let cache = null;

  return {
    /** @returns {Promise<string>} */
    async getAccessToken() {
      const now = Date.now();
      if (cache && cache.expiresAt > now + 60_000) {
        return cache.accessToken;
      }

      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope,
        grant_type: "client_credentials",
      });

      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(60_000),
      });

      const text = await res.text();
      /** @type {{ access_token?: string; expires_in?: number; error?: string; error_description?: string }} */
      let json = {};
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`Azure ARM token endpoint returned non-JSON (${res.status})`);
        }
      }

      if (!res.ok || !json.access_token) {
        const detail = json.error_description || json.error || `HTTP ${res.status}`;
        throw new Error(`Azure ARM token request failed: ${detail}`);
      }

      const expiresIn =
        typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
      cache = {
        accessToken: json.access_token,
        expiresAt: now + expiresIn * 1000,
      };
      return cache.accessToken;
    },
  };
}
