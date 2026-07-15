import https from "node:https";
import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { mgtPort } from "./safeline-render.mjs";

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} method
 * @param {string} apiPath
 * @param {unknown} [body]
 */
export async function requestSafelineApi(baseUrl, token, method, apiPath, body) {
  const root = baseUrl.replace(/\/+$/, "");
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url = `${root}${path}`;
  const headers = {
    "X-SLCE-API-TOKEN": token,
    Accept: "application/json",
  };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, {
    method,
    headers,
    body: payload,
    // @ts-expect-error Node fetch agent
    agent: insecureAgent,
  });
  const text = await res.text();
  let parsed = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, body: parsed, raw: text };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {number} port
 * @param {string} token
 * @param {string} method
 * @param {string} apiPath
 * @param {unknown} [body]
 */
export function requestSafelineApiViaPct(user, pveHost, vmid, port, token, method, apiPath, body) {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url = `https://127.0.0.1:${port}${path}`;
  const tokenEsc = token.replace(/'/g, `'\\''`);
  const parts = [
    "set -euo pipefail",
    `token='${tokenEsc}'`,
    `url='${url}'`,
  ];
  if (body !== undefined) {
    const json = JSON.stringify(body).replace(/'/g, `'\\''`);
    parts.push(`data='${json}'`);
    parts.push(
      `code=$(curl -sk -o /tmp/hdc-safeline-api.out -w '%{http_code}' -X '${method}' -H \"X-SLCE-API-TOKEN: $token\" -H 'Content-Type: application/json' -d \"$data\" \"$url\")`,
    );
  } else {
    parts.push(
      `code=$(curl -sk -o /tmp/hdc-safeline-api.out -w '%{http_code}' -X '${method}' -H \"X-SLCE-API-TOKEN: $token\" \"$url\")`,
    );
  }
  parts.push("cat /tmp/hdc-safeline-api.out", "echo", "echo \"HDC_HTTP_CODE=$code\"");
  const script = parts.join("\n");
  const r = pctExec(user, pveHost, vmid, script, { capture: true });
  const lines = r.stdout.split("\n");
  let httpCode = 0;
  /** @type {string[]} */
  const bodyLines = [];
  for (const line of lines) {
    const m = line.match(/^HDC_HTTP_CODE=(\d+)$/);
    if (m) {
      httpCode = Number(m[1]);
      continue;
    }
    bodyLines.push(line);
  }
  const raw = bodyLines.join("\n").trim();
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { raw };
    }
  }
  const ok = httpCode >= 200 && httpCode < 300;
  return { ok, status: httpCode, body: parsed, raw, exitStatus: r.status };
}

/**
 * @param {string} baseUrl
 * @param {string} token
 */
export async function listSites(baseUrl, token) {
  return requestSafelineApi(baseUrl, token, "GET", "/api/open/site");
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {Record<string, unknown>} payload
 */
export async function createSite(baseUrl, token, payload) {
  return requestSafelineApi(baseUrl, token, "POST", "/api/open/site", payload);
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {number} liveId
 * @param {Record<string, unknown>} payload
 */
export async function updateSite(baseUrl, token, liveId, payload) {
  return requestSafelineApi(baseUrl, token, "PUT", `/api/open/site/${liveId}`, payload);
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {number[]} ids
 */
export async function deleteSites(baseUrl, token, ids) {
  return requestSafelineApi(baseUrl, token, "DELETE", "/api/open/site", { ids });
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} safeline
 * @param {string} token
 * @param {ReturnType<import("./safeline-sites-sync.mjs").planSiteSync>} plan
 */
export async function applySiteSyncPlan(user, pveHost, vmid, safeline, token, plan) {
  const port = mgtPort(safeline);
  const baseUrl = `https://127.0.0.1:${port}`;
  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const action of plan.actions) {
    if (action.action === "unchanged") {
      results.push({ ...action, ok: true });
      continue;
    }
    if (action.action === "create" && action.payload) {
      const r = requestSafelineApiViaPct(
        user,
        pveHost,
        vmid,
        port,
        token,
        "POST",
        "/api/open/site",
        action.payload,
      );
      const ok = r.ok && r.exitStatus === 0;
      results.push({ ...action, ok, status: r.status, response: r.body });
      if (!ok) {
        errout.write(`[hdc] safeline sites: create ${action.site_id} failed (HTTP ${r.status})\n`);
        return { ok: false, results };
      }
      continue;
    }
    if (action.action === "update" && action.payload && action.live_id != null) {
      const r = requestSafelineApiViaPct(
        user,
        pveHost,
        vmid,
        port,
        token,
        "PUT",
        `/api/open/site/${action.live_id}`,
        action.payload,
      );
      const ok = r.ok && r.exitStatus === 0;
      results.push({ ...action, ok, status: r.status, response: r.body });
      if (!ok) {
        errout.write(`[hdc] safeline sites: update ${action.site_id} failed (HTTP ${r.status})\n`);
        return { ok: false, results };
      }
      continue;
    }
    if (action.action === "delete" && action.live_id != null) {
      const r = requestSafelineApiViaPct(
        user,
        pveHost,
        vmid,
        port,
        token,
        "DELETE",
        "/api/open/site",
        { ids: [action.live_id] },
      );
      const ok = r.ok && r.exitStatus === 0;
      results.push({ ...action, ok, status: r.status, response: r.body });
      if (!ok) {
        errout.write(`[hdc] safeline sites: delete ${action.site_id} failed (HTTP ${r.status})\n`);
        return { ok: false, results };
      }
    }
  }

  return { ok: true, results };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} safeline
 * @param {string} token
 */
export function fetchLiveSitesViaPct(user, pveHost, vmid, safeline, token) {
  const port = mgtPort(safeline);
  const r = requestSafelineApiViaPct(user, pveHost, vmid, port, token, "GET", "/api/open/site");
  if (!r.ok || r.exitStatus !== 0) {
    throw new Error(`list sites failed (HTTP ${r.status})`);
  }
  return r.body;
}
