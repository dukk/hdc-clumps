import { pveDataArray, pveJsonRequest } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import { parseIsoVolid } from "./deployments.mjs";

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @param {string} node
 * @param {string} storage
 * @param {string} filename
 */
export async function isoExistsOnNodeStorage(
  apiBase,
  authorization,
  rejectUnauthorized,
  node,
  storage,
  filename,
) {
  const path = `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content`;
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    undefined,
  );
  const list = pveDataArray(body);
  const want = filename.replace(/^iso\//, "");
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rec = /** @type {Record<string, unknown>} */ (row);
    const volid = typeof rec.volid === "string" ? rec.volid : "";
    if (volid === `${storage}:iso/${want}` || volid.endsWith(`/${want}`)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {string} opts.windowsVolid
 * @param {string} opts.virtioVolid
 * @param {string} [opts.autounattendVolid]
 */
export async function verifyIsoVolidsOnNode(opts) {
  const missing = [];
  for (const [label, volid] of [
    ["windows", opts.windowsVolid],
    ["virtio", opts.virtioVolid],
    ...(opts.autounattendVolid ? [["autounattend", opts.autounattendVolid]] : []),
  ]) {
    const { storage, filename } = parseIsoVolid(volid);
    const ok = await isoExistsOnNodeStorage(
      opts.apiBase,
      opts.authorization,
      opts.rejectUnauthorized,
      opts.node,
      storage,
      filename,
    );
    if (!ok) missing.push({ label, volid });
  }
  if (missing.length) {
    const detail = missing.map((m) => `${m.label}: ${m.volid}`).join("; ");
    throw new Error(
      `ISO file(s) not found on node ${opts.node} storage — upload ISOs first (${detail})`,
    );
  }
}
