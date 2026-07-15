import { waitForPveTask } from "./pve-http.mjs";
import { applyQemuGuestResources } from "./proxmox-guest-resources.mjs";
import { applyGuestBootOptions } from "./proxmox-guest-startup.mjs";
import { enableQemuAgentInConfig } from "./proxmox-qemu-guest-agent-install.mjs";
import { ensureGuestPackageTag } from "./proxmox-guest-tags.mjs";
import { resolveProvisionVmid } from "./proxmox-vmid-conflict.mjs";

export { resolveProvisionVmid } from "./proxmox-vmid-conflict.mjs";

/**
 * @param {unknown} taskData Value from provisionResult.details.task.
 * @returns {string | null}
 */
export function extractPveUpid(taskData) {
  if (typeof taskData === "string" && taskData.trim()) {
    return taskData.trim();
  }
  return null;
}

/**
 * Wait for clone/create task, then enable QEMU guest agent in VM config.
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionResult} provisionResult
 * @param {object} auth
 * @param {string} auth.host.apiBase
 * @param {string} auth.host.pveNode
 * @param {string} auth.authorization
 * @param {boolean} auth.rejectUnauthorized
 * @param {number} vmid
 * @param {(line: string) => void} log
 * @param {import("./proxmox-guest-resources.mjs").GuestResourceOpts} [resourceOpts]
 */
export async function waitForCloneTaskAndEnableAgent(provisionResult, auth, vmid, log, resourceOpts) {
  const guestVmid = resolveProvisionVmid(provisionResult, vmid);
  const details = provisionResult.details;
  const reassigned =
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    /** @type {Record<string, unknown>} */ (details).vmid_reassigned === true;
  if (reassigned && guestVmid !== vmid) {
    log(
      `QEMU vmid ${vmid} was reassigned to ${guestVmid} during provision; update proxmox.qemu.vmid in config.json.`,
    );
  }

  const upid = extractPveUpid(provisionResult.details?.task);
  const cloneNode =
    typeof provisionResult.details?.node === "string"
      ? provisionResult.details.node
      : auth.host.pveNode;

  if (upid) {
    log(`QEMU ${guestVmid}: waiting for Proxmox clone task …`);
    await waitForPveTask({
      apiBase: auth.host.apiBase,
      node: cloneNode,
      upid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      log,
    });
    log(`QEMU ${guestVmid}: clone task completed.`);
  } else {
    log(`QEMU ${guestVmid}: no Proxmox task UPID — skipping task wait.`);
  }

  const statusOpts = {
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: cloneNode,
    vmid: guestVmid,
  };

  if (resourceOpts) {
    await applyQemuGuestResources({
      ...statusOpts,
      memoryMb: resourceOpts.memoryMb,
      cores: resourceOpts.cores,
      reboot: resourceOpts.reboot,
      log,
    });
  }

  if (resourceOpts?.boot?.startup) {
    await applyGuestBootOptions({
      guestType: "qemu",
      ...statusOpts,
      boot: resourceOpts.boot,
      log,
    });
  }

  await enableQemuAgentInConfig({
    apiBase: auth.host.apiBase,
    node: cloneNode,
    vmid: guestVmid,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    log,
  });

  const clumpId = provisionResult.details?.hdc_clump_id;
  if (typeof clumpId === "string" && clumpId.trim()) {
    await ensureGuestPackageTag({
      guestType: "qemu",
      ...statusOpts,
      clumpId,
      log,
    });
  }

  return { node: cloneNode, vmid: guestVmid };
}
