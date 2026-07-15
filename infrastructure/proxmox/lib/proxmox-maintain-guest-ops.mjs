import {
  clusterConfigByKey,
  loadProxmoxHostsByCluster,
  resolveProxmoxHost,
} from "./proxmox-config.mjs";
import { resolvePveSshForHost } from "./proxmox-pve-ssh.mjs";
import { locateGuestResource } from "./proxmox-query-diag.mjs";
import { fetchClusterVmResources } from "./proxmox-host-provisioner.mjs";
import { migrateQemuGuest } from "./proxmox-qemu-migrate.mjs";
import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "./proxmox-deploy-auth.mjs";
import {
  repairUbuntuQemuConsole,
  regenQemuCloudInitDrive,
} from "hdc/package/qemu-ubuntu-console-repair.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { stderr as errout } from "node:process";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[proxmox] maintain: ${line}\n`);
}

/**
 * @param {string} clumpRoot
 * @param {ReturnType<typeof createVaultAccess>} vault
 */
async function authorizeLead(clumpRoot, vault) {
  const loaded = loadProxmoxPackageConfig(clumpRoot);
  const cfg = loaded.data;
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: loaded.path,
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: (id, reason) => log(`skip ${JSON.stringify(id)} (${reason})`),
  });
  for (const ck of [...byCluster.keys()].sort()) {
    const members = byCluster.get(ck);
    if (!members?.length) continue;
    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn: (m) => log(`WARN ${m}`),
      verifyPaths: PROXMOX_MAINTAIN_VERIFY_PATHS,
      configCluster: clusterConfigByKey(cfg, ck),
      log,
    });
    if (auth) {
      return {
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        byCluster,
        cfg,
      };
    }
  }
  throw new Error("Could not authorize any Proxmox API endpoint");
}

/**
 * @param {Map<string, import("./proxmox-config.mjs").ProxmoxClusterMember[]>} byCluster
 * @param {string} pveNode
 */
function hostIdForNode(byCluster, pveNode) {
  for (const members of byCluster.values()) {
    for (const m of members) {
      if (m.pveNode === pveNode) return m.id;
    }
  }
  return null;
}

/**
 * Early-exit maintain paths for migrate / console / cloud-init repair.
 * @param {string[]} argv
 * @param {string} clumpRoot
 * @returns {Promise<{ handled: boolean; ok?: boolean; result?: object }>}
 */
export async function maybeRunProxmoxMaintainGuestOps(argv, clumpRoot) {
  const flags = parseArgvFlags(argv);
  const migrate = flags.migrate !== undefined;
  const repairConsole = flags["repair-console"] !== undefined || flags.repair_console !== undefined;
  const regenCi = flags["regen-cloudinit"] !== undefined || flags.regen_cloudinit !== undefined;
  if (!migrate && !repairConsole && !regenCi) {
    return { handled: false };
  }

  const vmidRaw = flagGet(flags, "vmid");
  if (!vmidRaw || !/^\d+$/.test(vmidRaw)) {
    throw new Error("--migrate / --repair-console / --regen-cloudinit require --vmid <n>");
  }
  const vmid = Number(vmidRaw);
  const dryRun = flags["dry-run"] !== undefined || flags.dry_run !== undefined;

  const deps = createNodeCliDeps();
  const vault = createVaultAccess(vaultDepsFromCli(deps));
  const auth = await authorizeLead(clumpRoot, vault);
  const resources = await fetchClusterVmResources(
    auth.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );
  const located = locateGuestResource(resources, vmid);
  if (!located) {
    return {
      handled: true,
      ok: false,
      result: { ok: false, vmid, message: `vmid ${vmid} not found in cluster` },
    };
  }
  const sourceHostId = hostIdForNode(auth.byCluster, located.node);
  if (!sourceHostId) {
    return {
      handled: true,
      ok: false,
      result: {
        ok: false,
        vmid,
        node: located.node,
        message: `No config host for PVE node ${located.node}`,
      },
    };
  }

  if (migrate) {
    const targetHost = flagGet(flags, "target-host", "target_host");
    if (!targetHost) {
      throw new Error("--migrate requires --target-host <proxmox-host-id>");
    }
    const target = resolveProxmoxHost(auth.cfg, targetHost);
    if (!target) {
      throw new Error(`Unknown or down target host ${JSON.stringify(targetHost)}`);
    }
    log(
      `migrate QEMU ${vmid}: ${located.node} → ${target.pveNode} (host ${targetHost})${dryRun ? " [dry-run]" : ""}`,
    );
    if (dryRun) {
      return {
        handled: true,
        ok: true,
        result: {
          ok: true,
          dry_run: true,
          action: "migrate",
          vmid,
          source_node: located.node,
          target_node: target.pveNode,
          target_host: targetHost,
        },
      };
    }
    if (located.type === "lxc") {
      throw new Error("migrate is QEMU-only (LXC not supported)");
    }
    await migrateQemuGuest({
      apiBase: auth.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      sourceNode: located.node,
      targetNode: target.pveNode,
      vmid,
      log,
    });
    return {
      handled: true,
      ok: true,
      result: {
        ok: true,
        action: "migrate",
        vmid,
        source_node: located.node,
        target_node: target.pveNode,
        target_host: targetHost,
      },
    };
  }

  const ssh = resolvePveSshForHost(clumpRoot, sourceHostId);
  if (repairConsole) {
    log(`repair-console vmid ${vmid} on ${sourceHostId}${dryRun ? " [dry-run]" : ""}`);
    if (dryRun) {
      return {
        handled: true,
        ok: true,
        result: { ok: true, dry_run: true, action: "repair-console", vmid, host_id: sourceHostId },
      };
    }
    const r = repairUbuntuQemuConsole({ user: ssh.user, host: ssh.host, vmid, log });
    return {
      handled: true,
      ok: r.ok,
      result: { ok: r.ok, action: "repair-console", vmid, host_id: sourceHostId, ...r },
    };
  }

  // regen-cloudinit
  const ipconfig0 = flagGet(flags, "ipconfig0");
  const ciuser = flagGet(flags, "ciuser");
  const nameserver = flagGet(flags, "nameserver");
  const searchdomain = flagGet(flags, "searchdomain");
  const storage = flagGet(flags, "cloudinit-storage", "cloudinit_storage") || "local-lvm";
  log(`regen-cloudinit vmid ${vmid} on ${sourceHostId}${dryRun ? " [dry-run]" : ""}`);
  if (dryRun) {
    return {
      handled: true,
      ok: true,
      result: {
        ok: true,
        dry_run: true,
        action: "regen-cloudinit",
        vmid,
        host_id: sourceHostId,
        cloudinit_storage: storage,
        ipconfig0: ipconfig0 ?? null,
      },
    };
  }
  const r = regenQemuCloudInitDrive({
    user: ssh.user,
    host: ssh.host,
    vmid,
    cloudinitStorage: storage,
    ipconfig0,
    ciuser,
    nameserver,
    searchdomain,
    log,
  });
  return {
    handled: true,
    ok: r.ok,
    result: { ok: r.ok, action: "regen-cloudinit", vmid, host_id: sourceHostId, ...r },
  };
}
