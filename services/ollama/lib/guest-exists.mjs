import {
  fetchClusterVmResources,
  locateVmidInCluster,
} from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @param {number} vmid
 */
export async function findClusterGuest(apiBase, authorization, rejectUnauthorized, vmid) {
  const resources = await fetchClusterVmResources(apiBase, authorization, rejectUnauthorized);
  return locateVmidInCluster(resources, vmid);
}
