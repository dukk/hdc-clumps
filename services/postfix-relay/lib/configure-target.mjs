import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { env } from "node:process";

import { parseSshUrl } from "hdc/cli/lib/users-bootstrap-hdc.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";
import { createConfigureExec } from "./postfix-relay-configure.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} proxmoxRoot clumps/infrastructure/proxmox
 * @param {Record<string, unknown>} cfg
 */
export function resolveConfigureTarget(proxmoxRoot, cfg) {
  const configure = isObject(cfg.configure) ? cfg.configure : {};
  const via = typeof configure.via === "string" ? configure.via.trim().toLowerCase() : "pct";
  const px = isObject(cfg.proxmox) ? cfg.proxmox : {};
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);

  if (via === "ssh") {
    const ssh = isObject(configure.ssh) ? configure.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
    if (!host) throw new Error("configure.via ssh requires configure.ssh.host");
    return { via: "ssh", exec: createConfigureExec("ssh", { user, host }) };
  }

  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) throw new Error("configure.via pct requires proxmox.host_id");
  if (!Number.isFinite(vmid) || vmid <= 0) {
    throw new Error("configure.via pct requires proxmox.lxc.vmid");
  }
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  return {
    via: "pct",
    exec: createConfigureExec("pct", {
      user: pveSsh.user,
      host: pveSsh.host,
      vmid,
      pveHost: pveSsh.host,
    }),
  };
}
