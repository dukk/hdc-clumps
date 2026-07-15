import { stderr as errout } from "node:process";

import { extractPveUpid } from "./proxmox-qemu-post-clone.mjs";
import { pveData, pveFormBody, pveJsonRequest, waitForPveTask } from "./pve-http.mjs";

/**
 * Offline-migrate a QEMU guest to another node (API).
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.sourceNode
 * @param {string} opts.targetNode
 * @param {number} opts.vmid
 * @param {string} [opts.targetStorage] single storage id for all disks on the target
 * @param {(line: string) => void} [opts.log]
 */
export async function migrateQemuGuest(opts) {
  const { apiBase, authorization, rejectUnauthorized, sourceNode, targetNode, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  if (sourceNode === targetNode) return;
  const path = `/nodes/${encodeURIComponent(sourceNode)}/qemu/${encodeURIComponent(String(vmid))}/migrate`;
  /** @type {Record<string, string | number | boolean>} */
  const fields = { target: targetNode, online: 0 };
  if (typeof opts.targetStorage === "string" && opts.targetStorage.trim()) {
    fields.targetstorage = opts.targetStorage.trim();
    log(
      `Migrating QEMU ${vmid} from ${sourceNode} to ${targetNode} (targetstorage=${fields.targetstorage}) …`,
    );
  } else {
    log(`Migrating QEMU ${vmid} from ${sourceNode} to ${targetNode} …`);
  }
  const body = await pveJsonRequest(
    "POST",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody(fields),
  );
  const upid = extractPveUpid(pveData(body));
  if (upid) {
    await waitForPveTask({
      apiBase,
      node: sourceNode,
      upid,
      authorization,
      rejectUnauthorized,
      timeoutMs: 600_000,
      log,
    });
  }
  log(`QEMU ${vmid} migrated to ${targetNode}.`);
}
