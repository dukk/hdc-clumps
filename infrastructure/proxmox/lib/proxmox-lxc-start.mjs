import { stderr as errout } from "node:process";

import { extractPveUpid } from "./proxmox-qemu-post-clone.mjs";
import { pveData, pveFormBody, pveJsonRequest, waitForPveTask } from "./pve-http.mjs";

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @returns {Promise<string>}
 */
export async function getLxcRuntimeStatus(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const path = `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}/status/current`;
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    undefined,
  );
  const data = pveData(body);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const status = /** @type {Record<string, unknown>} */ (data).status;
    if (typeof status === "string") return status.trim();
  }
  return "";
}

/**
 * POST /lxc/{vmid}/status/start and wait for the worker task.
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {(line: string) => void} [opts.log]
 */
export async function startLxc(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}/status/start`;
  log(`Starting LXC ${vmid} on ${node} (POST ${path}) …`);
  const body = await pveJsonRequest(
    "POST",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody({}),
  );
  const upid = extractPveUpid(pveData(body));
  if (upid) {
    await waitForPveTask({
      apiBase,
      node,
      upid,
      authorization,
      rejectUnauthorized,
      timeoutMs: 300_000,
      log,
    });
  }
  log(`LXC ${vmid} start task finished on ${node}.`);
}

/**
 * Start the CT if it is not already running (needed before pct exec).
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureLxcStarted(opts) {
  const { node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const current = await getLxcRuntimeStatus(opts);
  if (current === "running") {
    log(`LXC ${vmid} on ${node} already running — skip start.`);
    return;
  }
  log(
    `LXC ${vmid} on ${node} status ${current ? JSON.stringify(current) : "(unknown)"} — starting container …`,
  );
  await startLxc(opts);
  const after = await getLxcRuntimeStatus(opts);
  if (after !== "running") {
    throw new Error(`LXC ${vmid} on ${node} did not reach running state (status: ${after || "unknown"})`);
  }
}
