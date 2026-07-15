import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

/**
 * @param {string} host
 * @param {{ port?: number; scheme?: "https" | "http" }} [opts]
 */
export function synologyDsmBaseUrl(host, opts = {}) {
  const scheme = opts.scheme === "http" ? "http" : "https";
  const port = typeof opts.port === "number" && opts.port > 0 ? opts.port : scheme === "https" ? 5001 : 5000;
  return `${scheme}://${host}:${port}`;
}

/**
 * @param {string} url
 * @param {{ method?: string; rejectUnauthorized?: boolean; timeoutMs?: number }} [opts]
 * @returns {Promise<{ statusCode: number; body: string }>}
 */
export function dsmHttpRequest(url, opts = {}) {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // DSM HTTPS is usually self-signed. Default: do not verify. Pass rejectUnauthorized: true to verify.
  const verifyTls = opts.rejectUnauthorized === true;
  const u = new URL(url);
  const lib = u.protocol === "http:" ? httpRequest : httpsRequest;
  /** @type {import("node:https").RequestOptions} */
  const reqOpts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "http:" ? 80 : 443),
    path: `${u.pathname}${u.search}`,
    method,
    rejectUnauthorized: verifyTls,
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = lib(reqOpts, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`DSM request timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

/**
 * @param {string} body
 */
function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`DSM response was not JSON: ${body.slice(0, 200)}`);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.account
 * @param {string} opts.password
 * @param {(url: string, o?: object) => Promise<{ statusCode: number; body: string }>} [opts.httpRequest]
 */
export async function dsmLogin(opts) {
  const http = opts.httpRequest ?? dsmHttpRequest;
  const base = opts.baseUrl.replace(/\/$/, "");
  const infoRes = await http(
    `${base}/webapi/entry.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth`,
  );
  const info = parseJsonBody(infoRes.body);
  if (!info?.success || !info?.data?.["SYNO.API.Auth"]?.path) {
    throw new Error(`DSM API.Info failed (HTTP ${infoRes.statusCode})`);
  }
  const authPath = String(info.data["SYNO.API.Auth"].path);
  const authUrl =
    `${base}/webapi/${authPath}?api=SYNO.API.Auth&version=6&method=login` +
    `&account=${encodeURIComponent(opts.account)}` +
    `&passwd=${encodeURIComponent(opts.password)}` +
    `&format=sid`;
  const authRes = await http(authUrl);
  const auth = parseJsonBody(authRes.body);
  if (!auth?.success || !auth?.data?.sid) {
    const code = auth?.error?.code ?? authRes.statusCode;
    throw new Error(`DSM login failed for ${opts.account} (error ${code})`);
  }
  return {
    baseUrl: base,
    sid: String(auth.data.sid),
    authPath,
  };
}

/**
 * @param {object} opts
 * @param {{ baseUrl: string; sid: string }} opts.session
 * @param {string} opts.packageId
 * @param {"start" | "stop"} opts.method
 * @param {(url: string, o?: object) => Promise<{ statusCode: number; body: string }>} [opts.httpRequest]
 */
export async function dsmPackageControl(opts) {
  const http = opts.httpRequest ?? dsmHttpRequest;
  const { baseUrl, sid } = opts.session;
  const idParam = encodeURIComponent(JSON.stringify([opts.packageId]));
  const url =
    `${baseUrl}/webapi/entry.cgi?api=SYNO.Core.Package.Control&version=1` +
    `&method=${encodeURIComponent(opts.method)}&id=${idParam}&_sid=${encodeURIComponent(sid)}`;
  const res = await http(url);
  const body = parseJsonBody(res.body);
  if (!body?.success) {
    const code = body?.error?.code ?? res.statusCode;
    throw new Error(`DSM package ${opts.method} ${opts.packageId} failed (error ${code})`);
  }
  return body;
}

/**
 * Operator-side HTTP probe (no SSH).
 * @param {string} host
 * @param {number} port
 * @param {{ timeoutMs?: number; httpRequest?: typeof dsmHttpRequest }} [opts]
 */
export async function probeHttpIdentity(host, port, opts = {}) {
  const http = opts.httpRequest ?? dsmHttpRequest;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const url = `http://${host}:${port}/identity`;
  try {
    // LAN HTTP identity probe — no TLS.
    const res = await http(url, { timeoutMs });
    return { ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode };
  } catch (e) {
    return { ok: false, statusCode: 0, error: String(/** @type {Error} */ (e).message || e) };
  }
}
