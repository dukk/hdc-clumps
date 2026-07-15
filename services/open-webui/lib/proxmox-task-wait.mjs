import { stderr as errout } from "node:process";

import { extractPveUpid } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { waitForPveTask } from "../../../infrastructure/proxmox/lib/pve-http.mjs";

/**
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionResult} provisionResult
 * @param {object} auth
 * @param {string} auth.host.apiBase
 * @param {string} auth.host.pveNode
 * @param {string} auth.authorization
 * @param {boolean} auth.rejectUnauthorized
 * @param {string} logPrefix
 * @param {number} [vmid]
 */
export async function waitForOpenWebuiProvisionTask(provisionResult, auth, logPrefix, vmid) {
  const upid = extractPveUpid(provisionResult.details?.task);
  if (!upid) {
    errout.write(`[hdc] ${logPrefix}: no Proxmox task UPID in provision result — continuing without task wait.\n`);
    return;
  }
  const vmidLabel = vmid !== undefined ? ` (vmid ${vmid})` : "";
  errout.write(`[hdc] ${logPrefix}${vmidLabel}: waiting for Proxmox task to finish …\n`);
  await waitForPveTask({
    apiBase: auth.host.apiBase,
    node: auth.host.pveNode,
    upid,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    timeoutMs: 600_000,
    log: (line) => {
      errout.write(`[hdc] ${logPrefix}: ${line}\n`);
    },
  });
  errout.write(`[hdc] ${logPrefix}${vmidLabel}: Proxmox task completed.\n`);
}
