import { stderr as errout } from "node:process";

import { stopAndDestroyQemu } from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { extractPveUpid } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import {
  getQemuRuntimeStatus,
  startQemuGuest,
} from "../../../infrastructure/proxmox/lib/proxmox-qemu-start.mjs";
import { pveData, pveFormBody, pveJsonRequest, waitForPveTask } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import {
  fetchClusterVmResources,
  listQemuGuests,
  locateVmidInCluster,
} from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { waitForQemuGuestSshAfterBoot } from "hdc/package/qemu-guest-ssh-wait.mjs";
import { waitForSsh } from "hdc/package/ssh-wait.mjs";

export { waitForQemuGuestSshAfterBoot, waitForSsh, startQemuGuest };
import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";
import {
  collectClusterVmids,
  nextVmidCandidate,
} from "../../../infrastructure/proxmox/lib/proxmox-vmid-conflict.mjs";

export { stopAndDestroyQemu };
export { resolveProvisionVmid } from "../../../infrastructure/proxmox/lib/proxmox-vmid-conflict.mjs";
export {
  applyQemuGuestResources,
  rebootQemuGuest,
  guestResourceOptsFromBlock,
  parseGuestResourceSizing,
} from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @param {number} vmid
 */
export async function locateGuest(apiBase, authorization, rejectUnauthorized, vmid) {
  const resources = await fetchClusterVmResources(apiBase, authorization, rejectUnauthorized);
  return locateVmidInCluster(resources, vmid);
}

/**
 * Find a non-template QEMU guest by Proxmox name (case-insensitive).
 * @param {Record<string, unknown>[]} resources
 * @param {string} name
 * @returns {{ vmid: number; node: string; name: string } | null}
 */
export function locateGuestByName(resources, name) {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  for (const g of listQemuGuests(resources)) {
    if (g.name.trim().toLowerCase() === want) {
      return g;
    }
  }
  return null;
}

/**
 * Pick the smallest unused VMID >= start in the cluster.
 * @param {Record<string, unknown>[]} resources
 * @param {number} [start]
 * @returns {number}
 */
export function allocateNextVmid(resources, start = 100) {
  const used = collectClusterVmids(resources);
  const base = Number.isFinite(start) && start > 0 ? Math.floor(start) : 100;
  return nextVmidCandidate(base, used, new Set());
}

/**
 * @param {object} opts
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof createProxmoxHostProvisioner>} opts.provisioner
 * @param {string} opts.name
 * @param {number} opts.vmid
 * @param {number} opts.templateVmid
 * @param {Record<string, unknown>} opts.parameters
 */
export async function cloneQemuGuest(opts) {
  const result = await opts.provisioner.createVm(opts.log, {
    name: opts.name,
    vmid: opts.vmid,
    templateVmid: opts.templateVmid,
    parameters: opts.parameters,
  });
  return result;
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.hostname
 * @param {string} opts.ipCidr e.g. 192.0.2.2/24
 * @param {string} opts.gateway e.g. 192.0.2.1
 * @param {(line: string) => void} [opts.log]
 */
export async function applyQemuCloudInit(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid, hostname, ipCidr, gateway } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;
  const ipconfig0 = `ip=${ipCidr},gw=${gateway}`;
  const { publicKeyLines } = discoverLocalSshMaterial();
  const keys = publicKeyLines
    .map((line) => line.replace(/\r/g, "").trim())
    .filter(Boolean);
  /** @type {Record<string, string | number | boolean>} */
  const fields = {
    ipconfig0,
    name: hostname,
    ciupgrade: 0,
  };
  if (keys.length) {
    fields.ciuser = "root";
  }
  log(
    `Setting cloud-init on vmid ${vmid}: ${ipconfig0}, hostname ${hostname}` +
      (keys.length ? `, ciuser root` : " (no local ~/.ssh public keys)"),
  );
  await pveJsonRequest("PUT", apiBase, path, authorization, rejectUnauthorized, pveFormBody(fields));

  if (keys.length) {
    // PVE stores sshkeys urlencoded; API expects the parameter value urlencoded once (form decode → encoded blob).
    const sshBlob = encodeURIComponent(keys.join("\n"));
    const sshBody = `sshkeys=${encodeURIComponent(sshBlob)}`;
    log(`Setting cloud-init SSH keys on vmid ${vmid} (${keys.length} key(s)) …`);
    await pveJsonRequest("PUT", apiBase, path, authorization, rejectUnauthorized, sshBody);
  }

  const regenPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/cloudinit`;
  try {
    log(`Regenerating cloud-init drive for vmid ${vmid} …`);
    await pveJsonRequest("POST", apiBase, regenPath, authorization, rejectUnauthorized, undefined);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    log(`cloud-init regenerate skipped (${msg}) — stop/start the guest if keys or IP do not apply.`);
  }
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
/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {(line: string) => void} [opts.log]
 */
export async function stopQemuGuest(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/status/stop`;
  log(`Stopping QEMU ${vmid} on ${node} …`);
  try {
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
        timeoutMs: 120_000,
        log,
      });
    }
  } catch (e) {
    log(`Stop skipped or failed (${/** @type {Error} */ (e).message})`);
  }
}

export { migrateQemuGuest } from "../../../infrastructure/proxmox/lib/proxmox-qemu-migrate.mjs";

export { getQemuRuntimeStatus };
