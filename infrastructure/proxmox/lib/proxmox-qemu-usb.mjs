import { pveData, pveFormBody, pveJsonRequest } from "./pve-http.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";

/** USB vendor:product (lowercase hex) */
const USB_VID_PID_RE = /^[0-9a-f]{4}:[0-9a-f]{4}$/;

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} id
 */
export function validateUsbVendorProduct(id) {
  const t = String(id).trim().toLowerCase();
  if (!USB_VID_PID_RE.test(t)) {
    throw new Error(`USB id ${JSON.stringify(id)} must match vvvv:pppp (vendor:product)`);
  }
  return t;
}

/**
 * @param {object} entry
 * @param {string} entry.id vendor:product
 * @param {boolean} [entry.usb3]
 */
export function formatUsbEntry(entry) {
  const id = validateUsbVendorProduct(entry.id);
  const parts = [`host=${id}`];
  if (entry.usb3 === true) parts.push("usb3=1");
  return parts.join(",");
}

/**
 * @param {unknown} raw
 * @returns {Array<{ id: string; usb3?: boolean }>}
 */
export function normalizeUsbList(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((item, idx) => {
    if (!isObject(item)) {
      throw new Error(`usb[${idx}] must be an object with id`);
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) throw new Error(`usb[${idx}]: id required`);
    return {
      id: validateUsbVendorProduct(id),
      usb3: item.usb3 === true,
    };
  });
}

/**
 * @param {number} vmid
 * @param {ReturnType<typeof normalizeUsbList>} usb
 */
export function qmSetUsbCommand(vmid, usb) {
  const parts = usb.map((entry, idx) => `-usb${idx} ${formatUsbEntry(entry)}`);
  return `qm set ${vmid} ${parts.join(" ")}`;
}

/**
 * @param {object} opts
 * @param {string} opts.sshUser
 * @param {string} opts.sshHost
 * @param {number} opts.vmid
 * @param {ReturnType<typeof normalizeUsbList>} opts.usb
 * @param {(line: string) => void} [opts.log]
 */
export function applyQemuUsbViaSsh(opts) {
  const { sshUser, sshHost, vmid, usb } = opts;
  const log = opts.log ?? (() => {});
  if (!usb.length) return;
  const cmd = qmSetUsbCommand(vmid, usb);
  log(`SSH ${sshUser}@${sshHost}: ${cmd}`);
  const r = sshRemote(sshUser, sshHost, cmd, { capture: true });
  if (r.status !== 0) {
    throw new Error(
      `qm set USB on ${sshHost} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`}`,
    );
  }
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {ReturnType<typeof normalizeUsbList>} opts.usb
 * @param {string} [opts.sshUser] fallback when API token cannot set usb0
 * @param {string} [opts.sshHost]
 * @param {(line: string) => void} [opts.log]
 */
export async function applyQemuUsb(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid, usb, sshUser, sshHost } = opts;
  const log = opts.log ?? (() => {});
  if (!usb.length) return;

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
      `vmid ${vmid} is running — stop the VM before applying USB passthrough (deploy applies USB before start)`,
    );
  }

  /** @type {Record<string, string>} */
  const fields = {};
  usb.forEach((entry, idx) => {
    fields[`usb${idx}`] = formatUsbEntry(entry);
  });

  const configPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;
  for (const [key, value] of Object.entries(fields)) {
    log(`Setting ${key}=${value} on vmid ${vmid}`);
  }
  try {
    await pveJsonRequest(
      "PUT",
      apiBase,
      configPath,
      authorization,
      rejectUnauthorized,
      pveFormBody(fields),
    );
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    if (!/only root can set.*usb/i.test(msg)) {
      throw e;
    }
    if (!sshUser || !sshHost) {
      throw new Error(
        `${msg.trim()} — use a root@pam API token or ensure SSH to the Proxmox host works for qm set`,
      );
    }
    log(`USB via API denied for token — applying with qm set over SSH …`);
    applyQemuUsbViaSsh({ sshUser, sshHost, vmid, usb, log });
  }
}
