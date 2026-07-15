import {
  allowedUbuntuQemuTemplateVmids,
  hdcUbuntuQemuTemplateName,
  isAllowedUbuntuLxcAppliance,
  isHdcUbuntuQemuVmidRange,
  isUbuntuVztmplVolid,
} from "./ubuntu-lts-catalog.mjs";
import { applianceTemplateFromVolid } from "./proxmox-lxc-templates.mjs";
import { listQemuTemplates } from "./proxmox-host-provisioner.mjs";
import { pveJsonRequest } from "./pve-http.mjs";

export { isUbuntuVztmplVolid };

/**
 * @param {string} apiBase
 * @param {string} node
 * @param {string} storage
 * @param {string} volid full volid e.g. local:vztmpl/ubuntu-18.04-...
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function deleteLxcVztmpl(
  apiBase,
  node,
  storage,
  volid,
  authorization,
  rejectUnauthorized,
) {
  const encoded = encodeURIComponent(volid);
  const path = `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content/${encoded}`;
  await pveJsonRequest("DELETE", apiBase, path, authorization, rejectUnauthorized, undefined);
}

/**
 * @param {string} apiBase
 * @param {string} node
 * @param {number} vmid
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function deleteQemuGuest(apiBase, node, vmid, authorization, rejectUnauthorized) {
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}`;
  await pveJsonRequest("DELETE", apiBase, path, authorization, rejectUnauthorized, undefined);
}

/**
 * @param {string[]} volids
 * @param {string} storage
 */
export function lxcVolidsToPrune(volids) {
  /** @type {string[]} */
  const out = [];
  for (const volid of volids) {
    if (!isUbuntuVztmplVolid(volid)) continue;
    const appliance = applianceTemplateFromVolid(volid);
    if (!appliance || isAllowedUbuntuLxcAppliance(appliance)) continue;
    out.push(volid);
  }
  return out;
}

/**
 * @param {Record<string, unknown>[]} resources cluster VM resources
 */
export function qemuTemplatesToPrune(resources) {
  const allowed = allowedUbuntuQemuTemplateVmids();
  const templates = listQemuTemplates(resources);
  /** @type {{ vmid: number; node: string; name: string }[]} */
  const out = [];
  for (const t of templates) {
    const inRange = isHdcUbuntuQemuVmidRange(t.vmid);
    const hdcName = hdcUbuntuQemuTemplateName(t.name);
    if (!inRange && !hdcName) continue;
    if (allowed.has(t.vmid)) continue;
    out.push(t);
  }
  return out;
}
