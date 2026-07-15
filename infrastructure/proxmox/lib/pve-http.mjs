import https from "node:https";

/**
 * @param {unknown} body
 * @returns {body is Record<string, unknown>}
 */
function isObject(body) {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

/**
 * @param {string} method
 * @param {string} baseUrl
 * @param {string} path e.g. /nodes/hypervisor-a/lxc (no /api2/json prefix)
 * @param {string} authorization full Authorization header value
 * @param {boolean} rejectUnauthorized
 * @param {string | undefined} formBody application/x-www-form-urlencoded
 * @returns {Promise<unknown>}
 */
export function pveJsonRequest(method, baseUrl, path, authorization, rejectUnauthorized, formBody) {
  const root = baseUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${root}/api2/json${p}`;
  const agent = new https.Agent({ rejectUnauthorized });
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        agent,
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          ...(formBody ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(formBody) } : {}),
        },
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
            reject(new Error(`Invalid JSON from Proxmox (${res.statusCode}): ${String(e)}`));
            return;
          }
          const code = res.statusCode ?? 0;
          if (code < 200 || code >= 300) {
            const msg = summarizePveError(parsed);
            reject(new Error(`Proxmox HTTP ${code} ${p}${msg ? `: ${msg}` : ""}`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    if (formBody) req.write(formBody);
    req.end();
  });
}

/**
 * @param {unknown} body
 */
function summarizePveError(body) {
  if (!isObject(body)) return "";
  const errors = body.errors;
  if (!isObject(errors)) return typeof body.message === "string" ? body.message : "";
  try {
    return JSON.stringify(errors);
  } catch {
    return "errors";
  }
}

/**
 * @param {unknown} body
 * @returns {unknown}
 */
export function pveData(body) {
  if (!isObject(body)) return null;
  return "data" in body ? body.data : body;
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>[]}
 */
export function pveDataArray(body) {
  const d = pveData(body);
  return Array.isArray(d) ? d.filter(isObject) : [];
}

/**
 * Proxmox form bodies must use encodeURIComponent (not URLSearchParams), so spaces
 * are %20 and '+' in SSH keys/base64 stay %2B — '+' as space breaks sshkeys validation.
 *
 * @param {Record<string, string | number | boolean | (string | number | boolean)[]>} fields
 */
export function pveFormBody(fields) {
  /** @type {string[]} */
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null) continue;
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

/**
 * @param {unknown} upid
 * @returns {string | null}
 */
export function pveUpidNode(upid) {
  const s = String(upid ?? "").trim();
  if (!s.startsWith("UPID:")) return null;
  const parts = s.split(":");
  return parts.length >= 2 && parts[1] ? parts[1] : null;
}

/**
 * Whether a stopped Proxmox task exitstatus should fail the caller.
 * @param {string} exit
 */
export function pveTaskExitIsError(exit) {
  const t = String(exit ?? "").trim();
  if (t === "OK") return false;
  if (/^WARNINGS:\s+\d+$/i.test(t)) return false;
  return true;
}

/**
 * Poll a Proxmox worker task until it stops.
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.upid
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {number} [opts.timeoutMs]
 * @param {(line: string) => void} [opts.log]
 */
export async function waitForPveTask(opts) {
  const {
    apiBase,
    node,
    upid,
    authorization,
    rejectUnauthorized,
    timeoutMs = 30 * 60 * 1000,
    log,
  } = opts;
  const taskNode = pveUpidNode(upid) ?? node;
  const path = `/nodes/${encodeURIComponent(taskNode)}/tasks/${encodeURIComponent(upid)}/status`;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await pveJsonRequest(
      "GET",
      apiBase,
      path,
      authorization,
      rejectUnauthorized,
      undefined,
    );
    const data = pveData(body);
    if (!isObject(data)) {
      await sleep(2000);
      continue;
    }
    const status = typeof data.status === "string" ? data.status : "";
    if (status === "stopped") {
      const exit = typeof data.exitstatus === "string" ? data.exitstatus : "";
      if (!pveTaskExitIsError(exit)) return;
      throw new Error(`Proxmox task ${upid} failed: ${exit || "unknown exit status"}`);
    }
    log?.(`task ${upid} still running …`);
    await sleep(2000);
  }
  throw new Error(`Proxmox task ${upid} timed out after ${timeoutMs}ms`);
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
