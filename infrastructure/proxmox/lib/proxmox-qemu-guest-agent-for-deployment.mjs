import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { authorizeProxmoxForHost } from "./proxmox-deploy-auth.mjs";
import {
  fetchClusterVmResources,
  listQemuGuests,
  locateVmidInCluster,
} from "./proxmox-host-provisioner.mjs";
import { ensureQemuGuestAgentOnDeploy } from "./proxmox-qemu-guest-agent-install.mjs";
import { pingQemuGuestAgent } from "./proxmox-qemu-guest-agent.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @typedef {object} ServiceQemuDeployment
 * @property {string} systemId
 * @property {string} [mode]
 * @property {string} [hostname]
 * @property {Record<string, unknown> | null} [proxmox]
 * @property {Record<string, unknown> | null} [configure]
 */

/**
 * @param {Record<string, unknown>[]} resources
 * @param {string} name
 * @returns {{ vmid: number; node: string; name: string } | null}
 */
export function locateQemuGuestByName(resources, name) {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  for (const g of listQemuGuests(resources)) {
    if (g.name.trim().toLowerCase() === want) {
      return g;
    }
  }
  return null;
}

/**
 * @param {ServiceQemuDeployment} deployment
 * @param {string} [defaultSshHost]
 */
export function sshTargetForGuestAgentDeployment(deployment, defaultSshHost) {
  const cfg = deployment.configure;
  const ssh = isObject(cfg) && isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  let host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
  if (!host && typeof defaultSshHost === "string" && defaultSshHost.trim()) {
    host = defaultSshHost.trim();
  }
  return { user, host };
}

/**
 * @param {ServiceQemuDeployment} deployment
 */
export function guestHostnameForDeployment(deployment) {
  if (deployment.hostname && deployment.hostname.trim()) {
    return deployment.hostname.trim();
  }
  const px = deployment.proxmox;
  if (isObject(px)) {
    const q = isObject(px.qemu) ? px.qemu : {};
    const name = typeof q.name === "string" ? q.name.trim() : "";
    if (name) return name;
  }
  return deployment.systemId.replace(/^vm-/, "");
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @param {ServiceQemuDeployment} deployment
 * @returns {Promise<{ vmid: number; node: string } | null>}
 */
export async function resolveQemuGuestPlacement(apiBase, authorization, rejectUnauthorized, deployment) {
  const px = deployment.proxmox;
  if (!isObject(px)) return null;

  const resources = await fetchClusterVmResources(apiBase, authorization, rejectUnauthorized);
  const q = isObject(px.qemu) ? px.qemu : {};
  const vmidRaw = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
  if (Number.isFinite(vmidRaw) && vmidRaw > 0) {
    const located = locateVmidInCluster(resources, vmidRaw);
    if (located) {
      return { vmid: vmidRaw, node: located.node };
    }
    return null;
  }

  const byName = locateQemuGuestByName(resources, guestHostnameForDeployment(deployment));
  if (byName) {
    return { vmid: byName.vmid, node: byName.node };
  }
  return null;
}

/**
 * Enable agent in VM config, install in guest via SSH, optionally verify ping.
 * Throws on failure (for deploy).
 *
 * @param {object} opts
 * @param {string} opts.proxmoxPackageRoot
 * @param {ServiceQemuDeployment} opts.deployment
 * @param {string} [opts.defaultSshHost]
 * @param {boolean} [opts.verifyPing]
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureQemuGuestAgentForDeployment(opts) {
  const { proxmoxPackageRoot, deployment, defaultSshHost, verifyPing = true, log } = opts;
  const mode = typeof deployment.mode === "string" ? deployment.mode.trim() : "proxmox-qemu";
  const px = deployment.proxmox;
  if (mode !== "proxmox-qemu" || !isObject(px)) {
    log?.(`${deployment.systemId}: not proxmox-qemu — guest agent skipped.`);
    return { ok: true, skipped: true, reason: "not_proxmox_qemu" };
  }

  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    log?.(`${deployment.systemId}: missing proxmox.host_id — guest agent skipped.`);
    return { ok: true, skipped: true, reason: "no_host_id" };
  }

  const { user, host } = sshTargetForGuestAgentDeployment(deployment, defaultSshHost);
  if (!host) {
    throw new Error(`${deployment.systemId}: configure.ssh.host or defaultSshHost required for guest agent`);
  }

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxPackageRoot, hostId });
  const placement = await resolveQemuGuestPlacement(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    deployment,
  );
  if (!placement) {
    throw new Error(
      `${deployment.systemId}: QEMU guest not found in cluster (check vmid or hostname ${guestHostnameForDeployment(deployment)})`,
    );
  }

  const { vmid, node } = placement;
  log?.(`${deployment.systemId}: ensuring qemu-guest-agent on QEMU ${vmid} (${node}) …`);

  await ensureQemuGuestAgentOnDeploy({
    apiBase: auth.host.apiBase,
    node,
    vmid,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    sshUser: user,
    sshHost: host,
    verifyPing,
    log,
  });

  let agentPing = false;
  if (verifyPing) {
    const probe = await pingQemuGuestAgent(
      auth.host.apiBase,
      node,
      vmid,
      auth.authorization,
      auth.rejectUnauthorized,
    );
    agentPing = probe.ok;
  }

  return {
    ok: true,
    skipped: false,
    system_id: deployment.systemId,
    vmid,
    node,
    agent_ping: agentPing,
  };
}

/**
 * Maintain-safe wrapper: records failure instead of throwing.
 *
 * @param {object} opts
 * @param {string} opts.proxmoxPackageRoot
 * @param {ServiceQemuDeployment} opts.deployment
 * @param {string} [opts.defaultSshHost]
 * @param {boolean} [opts.verifyPing]
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureQemuGuestAgentForDeploymentMaintain(opts) {
  try {
    return await ensureQemuGuestAgentForDeployment(opts);
  } catch (e) {
    const message = String(/** @type {Error} */ (e).message || e);
    opts.log?.(`${opts.deployment.systemId}: guest agent failed: ${message}`);
    return {
      ok: false,
      skipped: false,
      system_id: opts.deployment.systemId,
      message,
    };
  }
}
