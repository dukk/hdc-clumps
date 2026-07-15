import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { waitForQemuGuestSshAfterBoot } from "hdc/package/qemu-guest-ssh-wait.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import {
  ensureLxcStarted,
  getLxcRuntimeStatus,
} from "../../../infrastructure/proxmox/lib/proxmox-lxc-start.mjs";
import {
  ensureQemuGuestStarted,
  getQemuRuntimeStatus,
} from "../../../infrastructure/proxmox/lib/proxmox-qemu-start.mjs";
import { locateGuest } from "../../bind/lib/proxmox-qemu-redeploy.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Resolve Proxmox guest vmid and node for a twenty deployment.
 * @param {ReturnType<import("./deployments.mjs").resolveTwentyDeployments>[number]} deployment
 */
function resolveGuestPlacement(deployment) {
  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    throw new Error("missing proxmox.host_id");
  }

  if (deployment.mode === "proxmox-qemu") {
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error("invalid proxmox.qemu.vmid");
    }
    return { hostId, mode: deployment.mode, vmid, node: null };
  }

  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    throw new Error("invalid proxmox.lxc.vmid");
  }
  const node =
    typeof lxc.node === "string" && lxc.node.trim()
      ? lxc.node.trim()
      : typeof px.host_id === "string"
        ? px.host_id.trim()
        : "";
  return { hostId, mode: deployment.mode, vmid, node };
}

/**
 * @param {object} opts
 * @param {ReturnType<import("./deployments.mjs").resolveTwentyDeployments>[number]} opts.deployment
 * @param {string} opts.proxmoxRoot
 * @param {Record<string, string>} [opts.flags]
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.waitForSsh]
 */
export async function ensureTwentyGuestReachable(opts) {
  const { deployment, proxmoxRoot, flags = {}, log, waitForSsh = true } = opts;
  const write = log ?? (() => {});
  const { hostId, mode, vmid } = resolveGuestPlacement(deployment);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const apiOpts = {
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
  };

  /** @type {{ guest_power_state: string; guest_started: boolean; node: string }} */
  const summary = { guest_power_state: "", guest_started: false, node: "" };

  if (mode === "proxmox-qemu") {
    const located = await locateGuest(apiOpts.apiBase, apiOpts.authorization, apiOpts.rejectUnauthorized, vmid);
    if (!located) {
      throw new Error(`QEMU vmid ${vmid} not found in cluster`);
    }
    summary.node = located.node;
    const startResult = await ensureQemuGuestStarted({
      ...apiOpts,
      node: located.node,
      vmid,
      log: write,
    });
    summary.guest_power_state = startResult.status;
    summary.guest_started = startResult.started;

    if (waitForSsh) {
      const configure = isObject(deployment.configure) ? deployment.configure : {};
      const sshCfg = isObject(configure.ssh) ? configure.ssh : {};
      const q = isObject(deployment.proxmox?.qemu) ? deployment.proxmox.qemu : {};
      const ip = typeof q.ip === "string" ? q.ip.trim() : "";
      const sshHost =
        typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];
      if (!sshHost) {
        throw new Error("configure.ssh.host or proxmox.qemu.ip required for SSH wait");
      }
      const sshUser = resolveGuestSshUser(sshCfg.user);
      await waitForQemuGuestSshAfterBoot({
        user: sshUser,
        host: sshHost,
        apiBase: apiOpts.apiBase,
        authorization: apiOpts.authorization,
        rejectUnauthorized: apiOpts.rejectUnauthorized,
        node: located.node,
        vmid,
        freshClone: false,
        proxmoxPackageRoot: proxmoxRoot,
        flags,
        log: write,
      });
    }
    return summary;
  }

  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const node =
    typeof lxc.node === "string" && lxc.node.trim()
      ? lxc.node.trim()
      : auth.host.pveNode || hostId;
  summary.node = node;
  const before = await getLxcRuntimeStatus({ ...apiOpts, node, vmid });
  await ensureLxcStarted({ ...apiOpts, node, vmid, log: write });
  const after = await getLxcRuntimeStatus({ ...apiOpts, node, vmid });
  summary.guest_power_state = after || before;
  summary.guest_started = before !== "running" && after === "running";
  return summary;
}

/**
 * Read guest power state without starting (for query diagnostics).
 * @param {object} opts
 * @param {ReturnType<import("./deployments.mjs").resolveTwentyDeployments>[number]} opts.deployment
 * @param {string} opts.proxmoxRoot
 */
export async function readTwentyGuestPowerState(opts) {
  const { deployment, proxmoxRoot } = opts;
  const { hostId, mode, vmid } = resolveGuestPlacement(deployment);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const apiOpts = {
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
  };

  if (mode === "proxmox-qemu") {
    const located = await locateGuest(apiOpts.apiBase, apiOpts.authorization, apiOpts.rejectUnauthorized, vmid);
    if (!located) {
      return { guest_power_state: "not_found", node: null, vmid };
    }
    const status = await getQemuRuntimeStatus({ ...apiOpts, node: located.node, vmid });
    return { guest_power_state: status || "unknown", node: located.node, vmid };
  }

  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const node =
    typeof lxc.node === "string" && lxc.node.trim()
      ? lxc.node.trim()
      : auth.host.pveNode || hostId;
  const status = await getLxcRuntimeStatus({ ...apiOpts, node, vmid });
  return { guest_power_state: status || "unknown", node, vmid };
}
