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
 * @param {(line: string) => void} [opts.log]
 */
export async function stopAndDestroyLxc(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const base = `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}`;

  try {
    log(`Stopping LXC ${vmid} on ${node} …`);
    const stopBody = await pveJsonRequest(
      "POST",
      apiBase,
      `${base}/status/stop`,
      authorization,
      rejectUnauthorized,
      pveFormBody({}),
    );
    const upid = extractPveUpid(pveData(stopBody));
    if (upid) {
      await waitForPveTask({
        apiBase,
        node,
        upid,
        authorization,
        rejectUnauthorized,
        timeoutMs: 120_000,
        log,
      });
    }
  } catch (e) {
    log(`Stop skipped or failed (${/** @type {Error} */ (e).message}) — continuing to destroy.`);
  }

  log(`Destroying LXC ${vmid} on ${node} …`);
  await pveJsonRequest("DELETE", apiBase, base, authorization, rejectUnauthorized, undefined);
  log(`LXC ${vmid} destroyed.`);
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {(line: string) => void} [opts.log]
 */
export async function stopAndDestroyQemu(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const base = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}`;

  try {
    log(`Stopping QEMU ${vmid} on ${node} …`);
    const stopBody = await pveJsonRequest(
      "POST",
      apiBase,
      `${base}/status/stop`,
      authorization,
      rejectUnauthorized,
      pveFormBody({}),
    );
    const upid = extractPveUpid(pveData(stopBody));
    if (upid) {
      await waitForPveTask({
        apiBase,
        node,
        upid,
        authorization,
        rejectUnauthorized,
        timeoutMs: 120_000,
        log,
      });
    }
  } catch (e) {
    log(`Stop skipped or failed (${/** @type {Error} */ (e).message}) — continuing to destroy.`);
  }

  log(`Destroying QEMU ${vmid} on ${node} (purge) …`);
  await pveJsonRequest(
    "DELETE",
    apiBase,
    `${base}?purge=1`,
    authorization,
    rejectUnauthorized,
    undefined,
  );
  log(`QEMU ${vmid} destroyed.`);
}
