import { env } from "node:process";

import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import { resolveProxmoxHost } from "./proxmox-config.mjs";
import { parseSshUrl } from "hdc/cli/lib/users-bootstrap-hdc.mjs";

/**
 * Resolve SSH user/host for a Proxmox hypervisor from clump config.
 * @param {string} proxmoxRoot Absolute path to clumps/infrastructure/proxmox
 * @param {string} hostId Config host id (e.g. pve-a, hypervisor-a)
 * @returns {{ user: string; host: string }}
 */
export function resolvePveSshForHost(proxmoxRoot, hostId) {
  const loaded = loadProxmoxPackageConfig(proxmoxRoot);
  const pveCfg = loaded.data;
  const hostRec = resolveProxmoxHost(pveCfg, hostId);
  if (!hostRec?.ssh) {
    throw new Error(`Proxmox host ${JSON.stringify(hostId)} has no ssh:// URL in proxmox config`);
  }
  const parsed = parseSshUrl(hostRec.ssh);
  if (!parsed?.host) {
    throw new Error(`Invalid ssh URL for Proxmox host ${JSON.stringify(hostId)}`);
  }
  const user =
    parsed.user ||
    (typeof env.HDC_PROXMOX_SSH_USER === "string" && env.HDC_PROXMOX_SSH_USER.trim()
      ? env.HDC_PROXMOX_SSH_USER.trim()
      : "root");
  return { user, host: parsed.host };
}
