import { stderr as errout } from "node:process";

import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { pingQemuGuestAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent.mjs";
import { findClusterGuest } from "./guest-exists.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";

/**
 * @param {object} opts
 * @param {string} opts.proxmoxRoot
 * @param {string} opts.hostId
 * @param {number} opts.vmid
 * @param {string} [opts.sshUser]
 * @param {string} [opts.sshHost]
 */
export async function queryKaliDesktopLive(opts) {
  const { proxmoxRoot, hostId, vmid, sshUser = "kali", sshHost } = opts;
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );
  if (!located) {
    return { ok: false, vmid, message: "guest not found in cluster" };
  }

  let agent = { ok: false, message: "not_checked" };
  try {
    agent = await pingQemuGuestAgent(
      auth.host.apiBase,
      located.node,
      vmid,
      auth.authorization,
      auth.rejectUnauthorized,
    );
  } catch (e) {
    agent = { ok: false, message: String(/** @type {Error} */ (e).message || e) };
  }

  let sshProbe = null;
  if (sshHost) {
    const r = sshRemote(
      sshUser,
      sshHost,
      "echo hdc-ssh-ok",
      { capture: true },
    );
    sshProbe = { ok: r.status === 0 && r.stdout.includes("hdc-ssh-ok"), exit: r.status };
  }

  errout.write(
    `[hdc] kali-desktop query: vmid ${vmid} on ${located.node} status=${located.status ?? "unknown"} agent=${agent.ok ? "ok" : "fail"} ssh=${sshProbe?.ok ? "ok" : "n/a"}\n`,
  );

  return {
    ok: true,
    vmid,
    node: located.node,
    name: located.name,
    status: located.status ?? null,
    agent,
    ssh: sshProbe,
  };
}
