import { pveData, pveFormBody, pveJsonRequest } from "./pve-http.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";

/** PCI BDF: 0000:bb:dd.f */
const PCI_BDF_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/i;

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} id
 */
export function validatePciBdf(id) {
  const t = String(id).trim().toLowerCase();
  if (!PCI_BDF_RE.test(t)) {
    throw new Error(`hostpci id ${JSON.stringify(id)} must match 0000:bb:dd.f`);
  }
  return t;
}

/**
 * @param {object} entry
 * @param {string} entry.id PCI BDF
 * @param {boolean} [entry.pcie]
 * @param {boolean} [entry.rombar]
 * @param {boolean} [entry.xvga]
 */
export function formatHostpciEntry(entry) {
  const id = validatePciBdf(entry.id);
  const parts = [id];
  if (entry.pcie === true) parts.push("pcie=1");
  if (entry.rombar === false) parts.push("rombar=0");
  else if (entry.rombar === true) parts.push("rombar=1");
  if (entry.xvga === true) parts.push("x-vga=1");
  else if (entry.xvga === false) parts.push("x-vga=0");
  return parts.join(",");
}

/**
 * @param {unknown} raw
 * @returns {Array<{ id: string; pcie?: boolean; rombar?: boolean; xvga?: boolean }>}
 */
export function normalizeHostpciList(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((item, idx) => {
    if (!isObject(item)) {
      throw new Error(`hostpci[${idx}] must be an object with id`);
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) throw new Error(`hostpci[${idx}]: id required`);
    return {
      id,
      pcie: item.pcie === true,
      rombar: item.rombar === false ? false : item.rombar === true ? true : undefined,
      xvga: item.xvga === true ? true : item.xvga === false ? false : undefined,
    };
  });
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {ReturnType<typeof normalizeHostpciList>} opts.hostpci
 * @param {(line: string) => void} [opts.log]
 */
export async function applyQemuHostpci(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid, hostpci } = opts;
  const log = opts.log ?? (() => {});
  if (!hostpci.length) return;

  const statusPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/status/current`;
  const statusRes = await pveJsonRequest(
    "GET",
    apiBase,
    statusPath,
    authorization,
    rejectUnauthorized,
  );
  const status = pveData(statusRes);
  const running =
    isObject(status) && typeof status.status === "string" && status.status === "running";
  if (running) {
    throw new Error(
      `vmid ${vmid} is running — stop the VM before applying hostpci (deploy applies hostpci before start)`,
    );
  }

  /** @type {Record<string, string>} */
  const fields = {};
  hostpci.forEach((entry, idx) => {
    fields[`hostpci${idx}`] = formatHostpciEntry(entry);
  });

  const configPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;
  for (const [key, value] of Object.entries(fields)) {
    log(`Setting ${key}=${value} on vmid ${vmid}`);
  }
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody(fields),
  );
}

/**
 * Apply hostpci via `qm set` over SSH (root on the PVE node).
 * Use when the API token cannot set raw PCI BDFs (non-mapped devices).
 * @param {object} opts
 * @param {string} opts.sshUser
 * @param {string} opts.sshHost PVE node where the VM is registered
 * @param {number} opts.vmid
 * @param {ReturnType<typeof normalizeHostpciList>} opts.hostpci
 * @param {(line: string) => void} [opts.log]
 */
export async function applyQemuHostpciViaSsh(opts) {
  const { sshUser, sshHost, vmid, hostpci } = opts;
  const log = opts.log ?? (() => {});
  if (!hostpci.length) return;

  const args = hostpci
    .map((entry, idx) => `-hostpci${idx} ${formatHostpciEntry(entry)}`)
    .join(" ");
  const cmd = `qm set ${vmid} ${args}`;
  log(`SSH ${sshUser}@${sshHost}: ${cmd}`);
  const r = sshRemote(sshUser, sshHost, cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(`qm set hostpci failed on ${sshHost}: ${detail}`);
  }
}
