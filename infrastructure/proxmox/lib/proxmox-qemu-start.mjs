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
export async function getQemuRuntimeStatus(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/status/current`;
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
 * POST /qemu/{vmid}/status/start and wait for the worker task.
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {(line: string) => void} [opts.log]
 */
export async function startQemuGuest(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const current = await getQemuRuntimeStatus({ apiBase, authorization, rejectUnauthorized, node, vmid });
  if (current === "running") {
    log(`QEMU ${vmid} on ${node} already running — skip start.`);
    return;
  }
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/status/start`;
  log(`Starting QEMU ${vmid} on ${node} …`);
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
  log(`QEMU ${vmid} start task finished on ${node}.`);
}

/**
 * Start the QEMU guest if it is not already running (needed before guest SSH).
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureQemuGuestStarted(opts) {
  const { node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const current = await getQemuRuntimeStatus(opts);
  if (current === "running") {
    log(`QEMU ${vmid} on ${node} already running — skip start.`);
    return { started: false, status: current };
  }
  log(
    `QEMU ${vmid} on ${node} status ${current ? JSON.stringify(current) : "(unknown)"} — starting VM …`,
  );
  await startQemuGuest(opts);
  const after = await getQemuRuntimeStatus(opts);
  if (after !== "running") {
    throw new Error(`QEMU ${vmid} on ${node} did not reach running state (status: ${after || "unknown"})`);
  }
  return { started: true, status: after };
}
