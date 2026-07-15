import https from "node:https";
import http from "node:http";

/**
 * @param {import("node:https").RequestOptions & { url: string; body?: string }} opts
 */
export function requestJson(opts) {
  const { url, body, ...rest } = opts;
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const lib = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || defaultPort,
        path: `${u.pathname}${u.search}`,
        method: rest.method ?? "GET",
        headers: rest.headers ?? {},
        rejectUnauthorized: isHttps ? rest.rejectUnauthorized !== false : undefined,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          /** @type {unknown} */
          let parsed;
          try {
            parsed = raw.length ? JSON.parse(raw) : null;
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url} (${res.statusCode}): ${String(e)}`));
            return;
          }
          if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
            const detail = formatUniFiApiError(parsed);
            const err = new Error(detail ? `HTTP ${res.statusCode} ${url}: ${detail}` : `HTTP ${res.statusCode} ${url}`);
            // @ts-expect-error attach
            err.statusCode = res.statusCode;
            // @ts-expect-error attach
            err.body = parsed;
            reject(err);
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * @param {unknown} body
 */
export function formatUniFiApiError(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const o = /** @type {Record<string, unknown>} */ (body);
  const meta = o.meta && typeof o.meta === "object" && !Array.isArray(o.meta) ? o.meta : null;
  if (!meta) return "";
  const parts = [];
  if (typeof meta.msg === "string" && meta.msg.trim()) parts.push(meta.msg.trim());
  if (typeof meta.rc === "string" && meta.rc.trim() && meta.rc !== "ok") parts.push(`rc=${meta.rc.trim()}`);
  return parts.join("; ");
}

/** @param {string} s */
export function baseUrlFromString(s) {
  const trimmed = s.trim();
  const withProto = /:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withProto);
  return `${u.protocol}//${u.host}`;
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>[]}
 */
export function classicDataArray(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const o = /** @type {Record<string, unknown>} */ (body);
  const meta = o.meta && typeof o.meta === "object" && !Array.isArray(o.meta) ? o.meta : null;
  const rc = meta && typeof meta.rc === "string" ? meta.rc : "";
  if (rc !== "ok") return [];
  const data = o.data;
  if (!Array.isArray(data)) return [];
  return data.filter((x) => x && typeof x === "object" && !Array.isArray(x)).map((x) => /** @type {Record<string, unknown>} */ (x));
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {boolean} rejectUnauthorized
 */
export async function integrationInfo(base, apiKey, rejectUnauthorized) {
  const url = `${base}/proxy/network/integration/v1/info`;
  return requestJson({
    url,
    headers: {
      Accept: "application/json",
      "X-API-KEY": apiKey,
    },
    rejectUnauthorized,
  });
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {boolean} rejectUnauthorized
 */
export async function integrationListSites(base, apiKey, rejectUnauthorized) {
  const url = `${base}/proxy/network/integration/v1/sites?limit=200&offset=0`;
  return requestJson({
    url,
    headers: {
      Accept: "application/json",
      "X-API-KEY": apiKey,
    },
    rejectUnauthorized,
  });
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>[]}
 */
function integrationPageData(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const data = /** @type {Record<string, unknown>} */ (body).data;
  if (!Array.isArray(data)) return [];
  return data.filter((x) => x && typeof x === "object" && !Array.isArray(x)).map((x) => /** @type {Record<string, unknown>} */ (x));
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} urlPath path after /proxy/network/integration/v1 (no leading slash)
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function integrationPaginatedGet(base, apiKey, urlPath, rejectUnauthorized) {
  /** @type {Record<string, unknown>[]} */
  const all = [];
  let offset = 0;
  const limit = 200;
  for (;;) {
    const sep = urlPath.includes("?") ? "&" : "?";
    const url = `${base}/proxy/network/integration/v1/${urlPath}${sep}offset=${offset}&limit=${limit}`;
    const body = await requestJson({
      url,
      headers: {
        Accept: "application/json",
        "X-API-KEY": apiKey,
      },
      rejectUnauthorized,
    });
    const chunk = integrationPageData(body);
    all.push(...chunk);
    const totalCount =
      body && typeof body === "object" && !Array.isArray(body) && typeof body.totalCount === "number"
        ? body.totalCount
        : chunk.length;
    if (chunk.length < limit || all.length >= totalCount) break;
    offset += limit;
  }
  return all;
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {boolean} rejectUnauthorized
 */
export async function classicNetworkconf(base, apiKey, siteId, rejectUnauthorized) {
  const pathSeg = encodeURIComponent(siteId);
  const url = `${base}/proxy/network/api/s/${pathSeg}/rest/networkconf`;
  return requestJson({
    url,
    headers: {
      Accept: "application/json",
      "X-API-KEY": apiKey,
    },
    rejectUnauthorized,
  });
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {string} resource classic rest segment (e.g. portforward)
 * @param {boolean} rejectUnauthorized
 */
export async function classicRestList(base, apiKey, siteId, resource, rejectUnauthorized) {
  const pathSeg = encodeURIComponent(siteId);
  const url = `${base}/proxy/network/api/s/${pathSeg}/rest/${resource}`;
  const body = await requestJson({
    url,
    headers: {
      Accept: "application/json",
      "X-API-KEY": apiKey,
    },
    rejectUnauthorized,
  });
  return classicDataArray(body);
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {string} resource
 * @param {"POST" | "PUT" | "DELETE"} method
 * @param {Record<string, unknown> | null} payload
 * @param {string | null} rowId
 * @param {boolean} rejectUnauthorized
 */
export async function classicRestWrite(base, apiKey, siteId, resource, method, payload, rowId, rejectUnauthorized) {
  const pathSeg = encodeURIComponent(siteId);
  let url = `${base}/proxy/network/api/s/${pathSeg}/rest/${resource}`;
  if (rowId) url += `/${encodeURIComponent(rowId)}`;
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/json",
    "X-API-KEY": apiKey,
  };
  let body;
  if (payload && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  return requestJson({
    url,
    method,
    headers,
    body,
    rejectUnauthorized,
  });
}

/** @param {string} siteKey */
export function normalizeClassicSiteKey(siteKey) {
  const s = String(siteKey ?? "").trim().toLowerCase();
  return s || "default";
}

/**
 * Classic REST uses site keys like "default"; Integration API uses UUID site ids.
 *
 * @param {unknown} sitesBody
 * @param {string} [preferredSiteId] integration id, classic key, or empty
 * @returns {{ integrationSiteId: string; classicSiteKey: string; siteName: string }}
 */
export function resolveUniFiSiteKeys(sitesBody, preferredSiteId = "") {
  const sites =
    sitesBody && typeof sitesBody === "object" && !Array.isArray(sitesBody) && Array.isArray(sitesBody.data)
      ? sitesBody.data.filter((x) => x && typeof x === "object" && !Array.isArray(x))
      : [];

  const pref = preferredSiteId.trim().toLowerCase();
  /** @type {Record<string, unknown> | undefined} */
  let match;
  if (pref) {
    match = sites.find((s) => {
      const id = typeof s.id === "string" ? s.id.trim().toLowerCase() : "";
      const name = typeof s.name === "string" ? s.name.trim().toLowerCase() : "";
      return id === pref || name === pref;
    });
  }
  if (!match && sites[0]) match = /** @type {Record<string, unknown>} */ (sites[0]);

  const integrationSiteId = match && typeof match.id === "string" ? match.id.trim() : "";
  const siteName = match && typeof match.name === "string" ? match.name.trim() : "";
  const classicSiteKey = normalizeClassicSiteKey(siteName || "default");

  if (!integrationSiteId) {
    throw new Error("Could not resolve UniFi site id from GET /integration/v1/sites. Set HDC_UNIFI_SITE_ID or default_site_id.");
  }

  return { integrationSiteId, classicSiteKey, siteName: siteName || classicSiteKey };
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteKey classic site key (e.g. default)
 * @param {string} resource
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<{ rows: Record<string, unknown>[]; siteKey: string }>}
 */
export async function classicRestListWithFallback(base, apiKey, siteKey, resource, rejectUnauthorized) {
  const primary = normalizeClassicSiteKey(siteKey);
  /** @type {string[]} */
  const keys = [primary];
  if (primary !== "default") keys.push("default");

  /** @type {Error | undefined} */
  let lastErr;
  for (const key of keys) {
    try {
      const rows = await classicRestList(base, apiKey, key, resource, rejectUnauthorized);
      return { rows, siteKey: key };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error(`classic REST ${resource} failed`);
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteKey
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<{ rows: Record<string, unknown>[]; siteKey: string }>}
 */
export async function classicPortForwards(base, apiKey, siteKey, rejectUnauthorized) {
  return classicRestListWithFallback(base, apiKey, siteKey, "portforward", rejectUnauthorized);
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {boolean} rejectUnauthorized
 */
export async function integrationListAllNetworkOverviews(base, apiKey, siteId, rejectUnauthorized) {
  return integrationPaginatedGet(
    base,
    apiKey,
    `sites/${encodeURIComponent(siteId)}/networks`,
    rejectUnauthorized,
  );
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {boolean} rejectUnauthorized
 */
export async function integrationListAllDevices(base, apiKey, siteId, rejectUnauthorized) {
  return integrationPaginatedGet(
    base,
    apiKey,
    `sites/${encodeURIComponent(siteId)}/devices`,
    rejectUnauthorized,
  );
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {boolean} rejectUnauthorized
 */
export async function integrationListAllClients(base, apiKey, siteId, rejectUnauthorized) {
  return integrationPaginatedGet(
    base,
    apiKey,
    `sites/${encodeURIComponent(siteId)}/clients`,
    rejectUnauthorized,
  );
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {boolean} rejectUnauthorized
 */
export async function integrationListPendingDevices(base, apiKey, rejectUnauthorized) {
  return integrationPaginatedGet(base, apiKey, "pending-devices", rejectUnauthorized);
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {boolean} rejectUnauthorized
 */
export async function integrationListFirewallPolicies(base, apiKey, siteId, rejectUnauthorized) {
  return integrationPaginatedGet(
    base,
    apiKey,
    `sites/${encodeURIComponent(siteId)}/firewall/policies`,
    rejectUnauthorized,
  );
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {boolean} rejectUnauthorized
 */
export async function integrationListFirewallZones(base, apiKey, siteId, rejectUnauthorized) {
  return integrationPaginatedGet(
    base,
    apiKey,
    `sites/${encodeURIComponent(siteId)}/firewall/zones`,
    rejectUnauthorized,
  );
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {boolean} rejectUnauthorized
 */
export async function classicActiveStations(base, apiKey, siteId, rejectUnauthorized) {
  const pathSeg = encodeURIComponent(siteId);
  const url = `${base}/proxy/network/api/s/${pathSeg}/stat/sta`;
  const body = await requestJson({
    url,
    method: "POST",
    headers: {
      Accept: "application/json",
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: "{}",
    rejectUnauthorized,
  });
  return classicDataArray(body);
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} siteId
 * @param {string} netId
 * @param {boolean} rejectUnauthorized
 */
export async function integrationNetworkDetail(base, apiKey, siteId, netId, rejectUnauthorized) {
  const url = `${base}/proxy/network/integration/v1/sites/${encodeURIComponent(siteId)}/networks/${encodeURIComponent(netId)}`;
  return requestJson({
    url,
    headers: {
      Accept: "application/json",
      "X-API-KEY": apiKey,
    },
    rejectUnauthorized,
  });
}
