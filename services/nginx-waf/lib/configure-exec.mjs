import { join } from "node:path";

import { createConfigureExec } from "./nginx-waf-configure.mjs";
import { sshTargetFromDeployment } from "./deployments.mjs";
import { loadProxmoxPackageConfig } from "../../../infrastructure/proxmox/lib/proxmox-package-config.mjs";
import { resolveProxmoxHost } from "../../../infrastructure/proxmox/lib/proxmox-config.mjs";
import { parseSshUrl } from "hdc/cli/lib/users-bootstrap-hdc.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";

const proxmoxRoot = join(repoRoot(), "packages", "infrastructure", "proxmox");

/**
 * @param {string} hostId
 */
function resolvePveSshForHost(hostId) {
  const loaded = loadProxmoxPackageConfig(proxmoxRoot);
  const hostRec = resolveProxmoxHost(loaded.data, hostId);
  if (!hostRec?.ssh) {
    throw new Error(`Proxmox host ${JSON.stringify(hostId)} has no ssh:// URL in proxmox config`);
  }
  const parsed = parseSshUrl(hostRec.ssh);
  if (!parsed?.host) {
    throw new Error(`Invalid ssh URL for Proxmox host ${JSON.stringify(hostId)}`);
  }
  const user = parsed.user || "root";
  return { user, host: parsed.host };
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").finalizeDeployment>} deployment
 */
export function configureExecFromDeployment(deployment) {
  const cfg = deployment.configure;
  const via =
    cfg && typeof cfg.via === "string" && cfg.via.trim() ? cfg.via.trim().toLowerCase() : "ssh";

  if (via === "qemu-guest") {
    const prox = deployment.proxmox;
    const hostId =
      prox && typeof prox.host_id === "string" && prox.host_id.trim() ? prox.host_id.trim() : "";
    const qemu = prox && typeof prox === "object" && prox.qemu && typeof prox.qemu === "object" ? prox.qemu : null;
    const vmid = qemu && typeof qemu.vmid === "number" ? qemu.vmid : Number(qemu?.vmid);
    if (!hostId || !Number.isFinite(vmid) || vmid <= 0) {
      throw new Error(
        `${deployment.systemId}: qemu-guest configure requires proxmox.host_id and proxmox.qemu.vmid`,
      );
    }
    const pveSsh = resolvePveSshForHost(hostId);
    return createConfigureExec("qemu-guest", {
      user: pveSsh.user,
      host: pveSsh.host,
      pveHost: pveSsh.host,
      vmid,
    });
  }

  return createConfigureExec("ssh", sshTargetFromDeployment(deployment));
}
