import { pveData, pveFormBody, pveJsonRequest, waitForPveTask } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import {
  fetchClusterVmResources,
  listQemuGuests,
} from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";

/**
 * @param {Record<string, unknown>[]} resources
 * @param {string} guestRef
 * @returns {{ vmid: number; node: string; name: string } | null}
 */
export function locateBackupGuest(resources, guestRef) {
  const ref = guestRef.trim();
  if (!ref) return null;
  const guests = listQemuGuests(resources);
  if (/^\d+$/.test(ref)) {
    const vmid = Number(ref);
    return guests.find((g) => g.vmid === vmid) ?? null;
  }
  const names = new Set([ref.toLowerCase(), ref.replace(/^vm-/, "").toLowerCase()]);
  const hits = guests.filter((g) => names.has(g.name.trim().toLowerCase()));
  if (hits.length === 1) return hits[0];
  return null;
}

/**
 * One-shot snapshot backup. Does not destroy the guest.
 * @param {object} opts
 * @param {string} opts.proxmoxRoot
 * @param {string} opts.hostId API auth host (cluster token)
 * @param {string} opts.guestRef vmid or guest name
 * @param {string} opts.storage
 * @param {(line: string) => void} opts.log
 */
export async function snapshotBackupGuest(opts) {
  const { proxmoxRoot, hostId, guestRef, storage, log } = opts;
  if (!hostId) throw new Error("backup requires proxmox.host_id for API auth");
  log(`Authorizing Proxmox API via ${hostId} for backup of ${guestRef} …`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const resources = await fetchClusterVmResources(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );
  const guest = locateBackupGuest(resources, guestRef);
  if (!guest) {
    throw new Error(`backup guest ${JSON.stringify(guestRef)} was not found in the cluster`);
  }
  log(`Backing up ${guest.name} vmid ${guest.vmid} on ${guest.node} to ${storage} (snapshot) …`);
  const body = await pveJsonRequest(
    "POST",
    auth.host.apiBase,
    `/nodes/${encodeURIComponent(guest.node)}/vzdump`,
    auth.authorization,
    auth.rejectUnauthorized,
    pveFormBody({
      vmid: guest.vmid,
      storage,
      mode: "snapshot",
      compress: "zstd",
      "notes-template": "hdc-freepbx-cutover",
    }),
  );
  const upid = String(pveData(body) ?? "").trim();
  if (!upid.startsWith("UPID:")) {
    throw new Error(`vzdump did not return a task id (got ${JSON.stringify(upid)})`);
  }
  log(`vzdump task ${upid}`);
  await waitForPveTask({
    apiBase: auth.host.apiBase,
    node: guest.node,
    upid,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    timeoutMs: 2 * 60 * 60 * 1000,
    log,
  });
  log(`Backup of vmid ${guest.vmid} finished OK.`);
  return { ok: true, vmid: guest.vmid, node: guest.node, name: guest.name, storage, upid };
}
