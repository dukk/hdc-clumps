import { spawnSync } from "node:child_process";

import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import {
  discoverLocalSshMaterial,
  sshReachableWithPubkey,
  sshSpawn,
} from "hdc/cli/lib/ssh-host-access.mjs";
import { automatedInventoryIdFromName } from "hdc/package/automated-ids.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";

import { fetchClusterVmResources } from "./proxmox-host-provisioner.mjs";
import { listProxmoxHypervisorSshTargets } from "./proxmox-host-os-maintain.mjs";
import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import { loadProxmoxHostsByCluster, clusterConfigByKey } from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "./proxmox-deploy-auth.mjs";
import { resolvePveSshForHost } from "./proxmox-pve-ssh.mjs";

/**
 * @param {string} line
 */
function log(line) {
  process.stderr.write(`[proxmox] maintenance-query: ${line}\n`);
}

/**
 * @param {string} clumpRoot
 */
async function authorizeLead(clumpRoot) {
  const root = repoRoot();
  const deps = createNodeCliDeps();
  const vault = createVaultAccess(vaultDepsFromCli(deps));
  const loaded = loadProxmoxPackageConfig(clumpRoot, { publicRoot: root, env: process.env });
  const cfg = loaded.data;
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: loaded.path,
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: (id, reason) => log(`skip ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) throw new Error("No Proxmox hosts in config");

  for (const ck of clusterKeys) {
    const members = byCluster.get(ck);
    if (!members?.length) continue;
    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn: (m) => log(`WARN ${m}`),
      verifyPaths: PROXMOX_MAINTAIN_VERIFY_PATHS,
      configCluster: clusterConfigByKey(cfg, ck),
      log: (m) => log(m),
    });
    if (!auth) continue;
    return { auth, byCluster, cfg };
  }
  throw new Error("Could not authorize any Proxmox API endpoint");
}

/**
 * @param {string} name
 */
function isSkippableGuestName(name) {
  const n = String(name ?? "").toLowerCase();
  return (
    n.includes("homeassistant") ||
    n.includes("haos") ||
    n.includes("win11") ||
    n.includes("windows") ||
    n.includes("template")
  );
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 */
export async function runRebootRequiredScan(opts) {
  const lead = await authorizeLead(opts.clumpRoot);
  const resources = await fetchClusterVmResources(
    lead.auth.host.apiBase,
    lead.auth.authorization,
    lead.auth.rejectUnauthorized,
  );

  /** @type {Map<string, string>} */
  const nodeToHost = new Map();
  for (const members of lead.byCluster.values()) {
    for (const m of members) nodeToHost.set(m.pveNode, m.id);
  }

  /** @type {Record<string, unknown>[]} */
  const rebootRequired = [];
  const usedIds = new Set();

  for (const r of resources) {
    if (!r || typeof r !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (r);
    if (row.template === 1 || row.template === true) continue;
    if (row.status !== "running") continue;
    const typ = typeof row.type === "string" ? row.type : "qemu";
    const name = typeof row.name === "string" ? row.name : "";
    if (isSkippableGuestName(name)) continue;
    const vmid = typeof row.vmid === "number" ? row.vmid : Number(row.vmid);
    const node = typeof row.node === "string" ? row.node.trim() : "";
    if (!Number.isFinite(vmid) || !node) continue;

    const hostId = nodeToHost.get(node);
    if (!hostId) continue;

    let needsReboot = false;
    let probeError = null;

    try {
      const ssh = resolvePveSshForHost(opts.clumpRoot, hostId);
      if (typ === "lxc") {
        const out = sshRemote(
          ssh.user,
          ssh.host,
          ["pct", "exec", String(vmid), "--", "test", "-f", "/var/run/reboot-required"],
          spawnSync,
        );
        needsReboot = out.status === 0;
      } else {
        probeError = "qemu reboot probe not implemented (skip or use guest SSH inventory)";
      }
    } catch (e) {
      probeError = e instanceof Error ? e.message : String(e);
    }

    if (!needsReboot) continue;

    const prefix = typ === "lxc" ? "ct" : "vm";
    const systemId = automatedInventoryIdFromName(prefix, { name, id: String(vmid) }, usedIds);

    rebootRequired.push({
      system_id: systemId,
      vmid,
      node,
      type: typ,
      name,
      probe_error: probeError,
    });
  }

  return {
    ok: true,
    mode: "reboot-required",
    reboot_required: rebootRequired,
    count: rebootRequired.length,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 */
export async function runPendingHypervisorOsScan(opts) {
  const root = repoRoot();
  const loaded = loadProxmoxPackageConfig(opts.clumpRoot, { publicRoot: root, env: process.env });
  const cfg = loaded.data;
  const targets = listProxmoxHypervisorSshTargets(cfg, process.env);
  const { identities } = discoverLocalSshMaterial();

  /** @type {Record<string, unknown>[]} */
  const hypervisors = [];

  for (const target of targets) {
    /** @type {Record<string, unknown>} */
    const row = { id: target.id };
    if (!sshReachableWithPubkey(target, spawnSync, process.env, identities)) {
      row.ok = false;
      row.message = "SSH unreachable";
      hypervisors.push(row);
      continue;
    }

    const pending = sshSpawn(
      target,
      [
        "bash",
        "-lc",
        "apt-get update -qq >/dev/null 2>&1; apt list --upgradable 2>/dev/null | tail -n +2 | wc -l",
      ],
      { spawnSync, env: process.env, mode: "pubkey", identities, timeoutMs: 300_000 },
    );
    const reboot = sshSpawn(target, ["test", "-f", "/var/run/reboot-required"], {
      spawnSync,
      env: process.env,
      mode: "pubkey",
      identities,
      timeoutMs: 60_000,
    });

    const n = parseInt(`${pending.stdout ?? ""}`.trim(), 10);
    row.ok = pending.status === 0;
    row.pending_updates = Number.isFinite(n) ? n : null;
    row.reboot_required = reboot.status === 0;
    hypervisors.push(row);
  }

  return {
    ok: true,
    mode: "pending-os-updates",
    hypervisors,
  };
}

/**
 * @param {string[]} argv
 * @param {string} clumpRoot
 * @returns {Promise<object | null>}
 */
export async function maybeRunProxmoxMaintenanceQuery(argv, clumpRoot) {
  const flags = parseArgvFlags(argv);
  const rebootRequired = flagGet(flags, "reboot-required", "reboot_required");
  const pendingOs = flagGet(flags, "pending-os-updates", "pending_os_updates");
  if (!rebootRequired && !pendingOs) return null;

  if (rebootRequired) {
    log("scanning guests for /var/run/reboot-required …");
    return runRebootRequiredScan({ clumpRoot });
  }

  log("scanning hypervisors for pending OS updates …");
  return runPendingHypervisorOsScan({ clumpRoot });
}
