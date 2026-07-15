import { pveData, pveJsonRequest } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import {
  buildOemLicenseProbeScript,
  parseOemLicenseProbeOutput,
  summarizeOemLicenseHost,
} from "../../../infrastructure/proxmox/lib/proxmox-oem-windows-license.mjs";
import {
  discoverLocalSshMaterial,
  sshBashLc,
} from "hdc/cli/lib/ssh-host-access.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 */
export async function queryVmPowerState(opts) {
  const path = `/nodes/${encodeURIComponent(opts.node)}/qemu/${encodeURIComponent(String(opts.vmid))}/status/current`;
  const body = await pveJsonRequest(
    "GET",
    opts.apiBase,
    path,
    opts.authorization,
    opts.rejectUnauthorized,
    undefined,
  );
  const data = pveData(body);
  const status =
    data && typeof data === "object" && !Array.isArray(data) && typeof data.status === "string"
      ? data.status
      : "unknown";
  return { status };
}

/**
 * @param {object} opts
 * @param {string} opts.proxmoxRoot
 * @param {string} opts.hostId
 * @param {string} opts.pveNode
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 */
export async function queryOemStatusOnHost(opts) {
  const ssh = resolvePveSshForHost(opts.proxmoxRoot, opts.hostId);
  const { identities } = discoverLocalSshMaterial();
  const script = buildOemLicenseProbeScript(opts.pveNode);
  const r = sshBashLc(
    { id: opts.hostId, host: ssh.host, user: ssh.user, clusterId: null },
    script,
    { spawnSync: opts.spawnSync, env: opts.env, mode: "pubkey", identities, timeoutMs: 60_000 },
  );
  if (r.status !== 0) {
    return { ok: false, error: `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().slice(0, 300) };
  }
  const parsed = parseOemLicenseProbeOutput(`${r.stdout ?? ""}`, opts.pveNode);
  const { status, summary } = summarizeOemLicenseHost({
    firmware: parsed.firmware,
    dumpedTables: parsed.dumpedTables,
    assigned: parsed.assigned,
  });
  return { ok: true, status, summary, ...parsed };
}
