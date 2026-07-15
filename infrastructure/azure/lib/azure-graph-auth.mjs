/**
 * OAuth2 client credentials for Microsoft Graph.
 *
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.clientId
 * @param {string} opts.clientSecret
 * @param {string} [opts.scope]
 */
export function createAzureGraphTokenProvider(opts) {
  const tenantId = opts.tenantId.trim();
  const clientId = opts.clientId.trim();
  const clientSecret = opts.clientSecret.trim();
  const scope = (opts.scope ?? "https://graph.microsoft.com/.default").trim();
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

  /** @type {{ accessToken: string; expiresAt: number } | null} */
  let cache = null;

  return {
    /**
     * @returns {Promise<string>}
     */
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
          throw new Error(`Azure token endpoint returned non-JSON (${res.status})`);
        }
      }

      if (!res.ok || !json.access_token) {
        const detail = json.error_description || json.error || `HTTP ${res.status}`;
        const hint =
          String(detail).includes("AADSTS700016")
            ? " Check HDC_AZURE_ENTRA_<APP>_APPLICATION_ID in clump .env (Application/client ID from Entra Overview — not Secret ID) and HDC_AZURE_ENTRA_TENANT_ID (Directory tenant ID). Default app is hdc → HDC_AZURE_ENTRA_HDC_APPLICATION_ID. Legacy HDC_AZURE_ENTRA_CLIENT_ID still works. Save .env if you edited it in the IDE; hdc does not reload unsaved buffers."
            : "";
        throw new Error(`Azure token request failed: ${detail}${hint}`);
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
