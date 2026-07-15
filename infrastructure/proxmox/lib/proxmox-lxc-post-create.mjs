import { waitForPveTask } from "./pve-http.mjs";
import { applyLxcGuestResources } from "./proxmox-guest-resources.mjs";
import { applyGuestBootOptions } from "./proxmox-guest-startup.mjs";
import { ensureGuestPackageTag } from "./proxmox-guest-tags.mjs";
import { extractPveUpid } from "./proxmox-qemu-post-clone.mjs";
import { resolveProvisionVmid } from "./proxmox-vmid-conflict.mjs";

export { resolveProvisionVmid } from "./proxmox-vmid-conflict.mjs";

/**
 * Wait for LXC create task, then apply memory/cores from config.
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
export async function waitForLxcCreateTaskAndApplyResources(
  provisionResult,
  auth,
  vmid,
  log,
  resourceOpts,
) {
  const guestVmid = resolveProvisionVmid(provisionResult, vmid);
  const upid = extractPveUpid(provisionResult.details?.task);
  const lxcNode =
    typeof provisionResult.details?.node === "string"
      ? provisionResult.details.node
      : auth.host.pveNode;

  if (upid) {
    log(`LXC ${guestVmid}: waiting for Proxmox create task …`);
    await waitForPveTask({
      apiBase: auth.host.apiBase,
      node: lxcNode,
      upid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      log,
    });
    log(`LXC ${guestVmid}: create task completed.`);
  } else if (!provisionResult.details?.skipped_provision) {
    log(`LXC ${guestVmid}: no Proxmox task UPID — skipping task wait.`);
  }

  const statusOpts = {
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: lxcNode,
    vmid: guestVmid,
  };

  if (resourceOpts) {
    await applyLxcGuestResources({
      ...statusOpts,
      memoryMb: resourceOpts.memoryMb,
      cores: resourceOpts.cores,
      reboot: resourceOpts.reboot,
      rebootOnChange: resourceOpts.rebootOnChange ?? true,
      log,
    });
  }

  if (resourceOpts?.boot?.startup) {
    await applyGuestBootOptions({
      guestType: "lxc",
      ...statusOpts,
      boot: resourceOpts.boot,
      log,
    });
  }

  const clumpId = provisionResult.details?.hdc_clump_id;
  if (typeof clumpId === "string" && clumpId.trim()) {
    await ensureGuestPackageTag({
      guestType: "lxc",
      ...statusOpts,
      clumpId,
      log,
    });
  }

  return { node: lxcNode, vmid: guestVmid };
}
