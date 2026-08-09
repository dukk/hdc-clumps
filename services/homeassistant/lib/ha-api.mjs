/**
 * Home Assistant REST API client (Bearer long-lived access token).
 */

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl e.g. http://192.0.2.30:8123 or https://ha.example.invalid
 * @param {string} opts.token
 */
export function createHaClient(opts) {
  const baseUrl = String(opts.baseUrl ?? "")
    .trim()
    .replace(/\/$/, "");
  const token = String(opts.token ?? "").trim();
  if (!baseUrl) throw new Error("Home Assistant API baseUrl is required");
  if (!token) throw new Error("Home Assistant API token is required");

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function request(method, path, body) {
    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    /** @type {RequestInit} */
    const init = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
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
          : typeof parsed === "string" && parsed.trim()
            ? parsed.trim().slice(0, 200)
            : `HTTP ${res.status}`;
      throw new Error(`Home Assistant API ${method} ${path}: ${detail}`);
    }
    return parsed;
  }

  return {
    baseUrl,
    /**
     * @param {string} path
     */
    get(path) {
      return request("GET", path);
    },
    /**
     * @param {string} path
     * @param {unknown} body
     */
    post(path, body) {
      return request("POST", path, body);
    },
    /**
     * @param {string} path
     */
    delete(path) {
      return request("DELETE", path);
    },
  };
}
