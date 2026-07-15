/**
 * Immich REST API client (system-config admin endpoints).
 */

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} immich
 * @param {string | null} [sshHost]
 */
export function resolveImmichApiBaseUrl(immich, sshHost = null) {
  const configured =
    typeof immich.public_url === "string" && immich.public_url.trim()
      ? immich.public_url.trim()
      : "";
  if (configured) {
    const u = configured.replace(/\/$/, "");
    return `${u}/api`;
  }
  const port =
    typeof immich.port === "number" && Number.isFinite(immich.port) ? immich.port : 2283;
  if (sshHost) return `http://${sshHost}:${port}/api`;
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase e.g. https://immich.example.invalid/api
 * @param {string} opts.apiKey
 */
export function createImmichApiClient(opts) {
  const apiBase = opts.apiBase.replace(/\/$/, "");
  const apiKey = opts.apiKey.trim();

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function request(method, path, body) {
    const url = `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
    /** @type {RequestInit} */
    const init = {
      method,
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey,
      },
    };
    if (body !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const detail =
        isObject(parsed) && typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed === "string"
            ? parsed
            : `HTTP ${res.status}`;
      throw new Error(`Immich API ${method} ${path}: ${detail}`);
    }
    if (isObject(parsed) && "data" in parsed) {
      return parsed.data;
    }
    return parsed;
  }

  return {
    apiBase,
    async getSystemConfig() {
      return request("GET", "/system-config");
    },
    async putSystemConfig(systemConfigDto) {
      return request("PUT", "/system-config", systemConfigDto);
    },
    /** @param {Record<string, unknown>} smtpDto notifications.smtp shape */
    async sendTestEmail(smtpDto) {
      return request("POST", "/admin/notifications/test-email", smtpDto);
    },
  };
}
