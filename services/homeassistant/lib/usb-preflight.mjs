import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { validateUsbVendorProduct } from "../../../infrastructure/proxmox/lib/proxmox-qemu-usb.mjs";

const LSUSB_ID_RE = /\bID\s+([0-9a-f]{4}):([0-9a-f]{4})\b/i;

/** Descriptions unlikely to be Zigbee/Z-Wave coordinators. */
const EXCLUDE_DESC_RE =
  /\b(hub|keyboard|mouse|bluetooth|ethernet|storage|mass storage|audio|webcam|camera|receiver|proxmox|root hub|internal|hub)\b/i;

/**
 * @typedef {{ id: string; description: string; line: string }} UsbDevice
 */

/**
 * @param {string} stdout
 * @returns {UsbDevice[]}
 */
export function parseLsusbOutput(stdout) {
  /** @type {UsbDevice[]} */
  const out = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(LSUSB_ID_RE);
    if (!m) continue;
    const id = `${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
    const desc = trimmed.replace(/^.*ID\s+[0-9a-f]{4}:[0-9a-f]{4}\s*/i, "").trim();
    out.push({ id, description: desc || trimmed, line: trimmed });
  }
  return out;
}

/**
 * @param {UsbDevice[]} devices
 */
export function filterCoordinatorCandidates(devices) {
  return devices.filter((d) => !EXCLUDE_DESC_RE.test(d.description));
}

/**
 * @param {object} opts
 * @param {string} opts.user
 * @param {string} opts.host
 * @param {Array<{ id: string }>} [opts.configured]
 * @param {string} [opts.overrideId] CLI --usb-id
 */
export async function resolveUsbDevicesForDeploy(opts) {
  const configured = Array.isArray(opts.configured) ? opts.configured : [];
  if (opts.overrideId) {
    return [{ id: validateUsbVendorProduct(opts.overrideId) }];
  }
  if (configured.length) {
    return configured.map((e) => ({ id: validateUsbVendorProduct(e.id) }));
  }

  const r = sshRemote(opts.user, opts.host, "lsusb", { capture: true });
  if (r.status !== 0) {
    throw new Error(`lsusb on ${opts.user}@${opts.host} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  }

  const all = parseLsusbOutput(r.stdout);
  const candidates = filterCoordinatorCandidates(all);

  if (candidates.length === 1) {
    return [{ id: candidates[0].id }];
  }

  if (candidates.length === 0) {
    const lines = all.map((d) => `  ${d.line}`).join("\n");
    throw new Error(
      `No USB coordinator candidate found on ${opts.host}. Plug in the dongle and re-run, or set proxmox.qemu.usb[].id in config.\n` +
        (lines ? `lsusb:\n${lines}` : "lsusb returned no devices."),
    );
  }

  const lines = candidates.map((d) => `  ${d.id}  ${d.description}`).join("\n");
  throw new Error(
    `Multiple USB devices on ${opts.host} — set proxmox.qemu.usb[].id in config or pass --usb-id vvvv:pppp:\n${lines}`,
  );
}
