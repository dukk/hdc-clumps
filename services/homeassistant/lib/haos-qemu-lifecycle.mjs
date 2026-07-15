import { stderr as errout } from "node:process";

import { extractPveUpid } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { pveData, pveFormBody, pveJsonRequest, waitForPveTask } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { startQemuGuest } from "../../bind/lib/proxmox-qemu-redeploy.mjs";

/**
 * Force-stop a HAOS QEMU guest (ACPI shutdown is unreliable; bypass config lock).
 *
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} [opts.sshUser]
 * @param {string} [opts.sshHost]
 * @param {(line: string) => void} [opts.log]
 */
export async function forceStopHaosQemuGuest(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/status/stop`;

  log(`Force-stopping QEMU ${vmid} on ${node} (skiplock, timeout=0) …`);
  try {
    const body = await pveJsonRequest(
      "POST",
      apiBase,
      path,
      authorization,
      rejectUnauthorized,
      pveFormBody({ skiplock: 1, timeout: 0 }),
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
    return;
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    if (!opts.sshUser || !opts.sshHost) {
      throw new Error(`${msg.trim()} — ensure SSH to the Proxmox host works for qm stop`);
    }
    log(`API force-stop failed (${msg.trim()}) — using qm stop over SSH …`);
  }

  const r = sshRemote(
    opts.sshUser,
    opts.sshHost,
    `qm stop ${vmid} --skiplock --timeout 0`,
    { capture: true },
  );
  if (r.status !== 0) {
    throw new Error(
      `qm stop ${vmid} on ${opts.sshHost} failed (${r.status}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

/**
 * Force-stop then start a HAOS QEMU guest (serial-console first-boot workaround).
 *
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} [opts.sshUser]
 * @param {string} [opts.sshHost]
 * @param {(line: string) => void} [opts.log]
 */
export async function restartHaosQemuGuest(opts) {
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  await forceStopHaosQemuGuest(opts);
  await startQemuGuest({
    apiBase: opts.apiBase,
    authorization: opts.authorization,
    rejectUnauthorized: opts.rejectUnauthorized,
    node: opts.node,
    vmid: opts.vmid,
    log,
  });
}
