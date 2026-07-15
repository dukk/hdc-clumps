import { stderr as errout } from "node:process";

import { extractPveUpid } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { waitForPveTask } from "../../../infrastructure/proxmox/lib/pve-http.mjs";

export { extractPveUpid };

/**
 * Poll the Proxmox worker task from a provision result until it completes.
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionResult} provisionResult
 * @param {object} auth
 * @param {string} auth.host.apiBase
 * @param {string} auth.host.pveNode
 * @param {string} auth.authorization
 * @param {boolean} auth.rejectUnauthorized
 * @param {string} systemId
 * @param {number} [vmid]
 */
export async function waitForOllamaProvisionTask(provisionResult, auth, systemId, vmid) {
  const upid = extractPveUpid(provisionResult.details?.task);
  if (!upid) {
    errout.write(
      `[hdc] ollama deploy: ${systemId}: no Proxmox task UPID in provision result — continuing without task wait.\n`,
    );
    return;
  }
  const vmidLabel = vmid !== undefined ? ` (vmid ${vmid})` : "";
  errout.write(`[hdc] ollama deploy: ${systemId}${vmidLabel}: waiting for Proxmox task to finish …\n`);
  await waitForPveTask({
    apiBase: auth.host.apiBase,
    node: auth.host.pveNode,
    upid,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    timeoutMs: 0,
    log: (line) => {
      errout.write(`[hdc] ollama deploy: ${systemId}: ${line}\n`);
    },
  });
  errout.write(`[hdc] ollama deploy: ${systemId}${vmidLabel}: Proxmox task completed.\n`);
}
