#!/usr/bin/env node
/**
 * Proxmox teardown: destroy a guest by VMID (optionally on every configured node).
 *
 * Usage:
 *   hdc run infrastructure proxmox teardown -- --vmid N --yes [--any-node] [--purge] [--dry-run] [--type qemu|lxc]
 *
 * --any-node: scan all configured hosts via SSH for leftover conf and destroy wherever found
 *             (plus API locate). Default: destroy only where cluster resources report the guest.
 * --purge:    pass purge=1 on QEMU destroy (default true for QEMU).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout, stdout as output } from "node:process";

import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "hdc/package/proxmox-deploy-auth.mjs";
import { stopAndDestroyLxc, stopAndDestroyQemu } from "hdc/package/proxmox-guest-destroy.mjs";
import { fetchClusterVmResources } from "hdc/package/proxmox-host-provisioner.mjs";
import { loadProxmoxPackageConfig } from "hdc/package/proxmox-package-config.mjs";
import {
  clusterConfigByKey,
  loadProxmoxHostsByCluster,
} from "hdc/package/proxmox-config.mjs";
import { resolvePveSshForHost } from "hdc/package/proxmox-pve-ssh.mjs";
import { locateGuestResource } from "hdc/package/proxmox-query-diag.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const target = "proxmox";
const verb = "teardown";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[proxmox] teardown: ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const vmidRaw = flagGet(flags, "vmid");
  if (!vmidRaw || !/^\d+$/.test(vmidRaw)) {
    errout.write(`[hdc] ${target} ${verb}: requires --vmid <n>\n`);
    process.exitCode = 1;
    return;
  }
  if (flags.yes === undefined) {
    errout.write(`[hdc] ${target} ${verb}: refusing without --yes\n`);
    process.exitCode = 1;
    return;
  }
  const vmid = Number(vmidRaw);
  const anyNode = flags["any-node"] !== undefined || flags.any_node !== undefined;
  const dryRun = flags["dry-run"] !== undefined || flags.dry_run !== undefined;
  const typeOverride = flagGet(flags, "type");
  const purge = flags.purge === undefined || flags.purge === "1" || flags.purge === "true";

  const deps = createNodeCliDeps();
  const vault = createVaultAccess(vaultDepsFromCli(deps));
  const loaded = loadProxmoxPackageConfig(clumpRoot);
  const cfg = loaded.data;
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: loaded.path,
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: (id, reason) => log(`skip ${JSON.stringify(id)} (${reason})`),
  });

  /** @type {{ apiBase: string; authorization: string; rejectUnauthorized: boolean } | null} */
  let api = null;
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
      api = {
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
      };
      break;
    }
  }
  if (!api) {
    errout.write(`[hdc] ${target} ${verb}: could not authorize Proxmox API\n`);
    process.exitCode = 1;
    return;
  }

  const resources = await fetchClusterVmResources(api.apiBase, api.authorization, api.rejectUnauthorized);
  const located = locateGuestResource(resources, vmid);

  /** @type {{ host_id: string; node: string; type: string; via: string }[]} */
  const targets = [];

  if (located) {
    let hostId = null;
    for (const members of byCluster.values()) {
      for (const m of members) {
        if (m.pveNode === located.node) {
          hostId = m.id;
          break;
        }
      }
      if (hostId) break;
    }
    if (hostId) {
      targets.push({
        host_id: hostId,
        node: located.node,
        type: typeOverride || located.type,
        via: "api",
      });
    }
  }

  if (anyNode) {
    for (const members of byCluster.values()) {
      for (const m of members) {
        if (targets.some((t) => t.host_id === m.id)) continue;
        try {
          const ssh = resolvePveSshForHost(clumpRoot, m.id);
          const q = sshRemote(ssh.user, ssh.host, `test -f /etc/pve/qemu-server/${vmid}.conf && echo qemu || true; test -f /etc/pve/lxc/${vmid}.conf && echo lxc || true`, {
            capture: true,
          });
          const text = `${q.stdout || ""}`;
          if (/\bqemu\b/.test(text)) {
            targets.push({ host_id: m.id, node: m.pveNode, type: "qemu", via: "ssh-conf" });
          } else if (/\blxc\b/.test(text)) {
            targets.push({ host_id: m.id, node: m.pveNode, type: "lxc", via: "ssh-conf" });
          }
        } catch (e) {
          log(`WARN scan ${m.id}: ${/** @type {Error} */ (e).message || e}`);
        }
      }
    }
  }

  if (!targets.length) {
    const payload = {
      target,
      verb,
      ok: true,
      vmid,
      message: `vmid ${vmid} not found (nothing to destroy)`,
      destroyed: [],
    };
    output.write(`${JSON.stringify(payload, null, 2)}\n`);
    runOperationReportTail({
      clumpRoot,
      repoRoot: repoRoot(),
      verb,
      argv,
      ok: true,
      payload,
      log,
    });
    return;
  }

  /** @type {object[]} */
  const destroyed = [];
  let ok = true;
  for (const t of targets) {
    log(
      `${dryRun ? "[dry-run] " : ""}destroy ${t.type} ${vmid} on ${t.host_id} (${t.node}) via ${t.via}${purge && t.type === "qemu" ? " purge" : ""}`,
    );
    if (dryRun) {
      destroyed.push({ ...t, dry_run: true });
      continue;
    }
    try {
      if (t.type === "lxc") {
        await stopAndDestroyLxc({
          apiBase: api.apiBase,
          authorization: api.authorization,
          rejectUnauthorized: api.rejectUnauthorized,
          node: t.node,
          vmid,
          log,
        });
      } else {
        await stopAndDestroyQemu({
          apiBase: api.apiBase,
          authorization: api.authorization,
          rejectUnauthorized: api.rejectUnauthorized,
          node: t.node,
          vmid,
          log,
        });
      }
      destroyed.push({ ...t, ok: true });
    } catch (e) {
      ok = false;
      const message = String(/** @type {Error} */ (e).message || e);
      log(`FAILED: ${message}`);
      destroyed.push({ ...t, ok: false, message });
    }
  }

  const payload = {
    target,
    verb,
    ok,
    vmid,
    any_node: anyNode,
    dry_run: dryRun,
    destroyed,
  };
  if (!ok) process.exitCode = 1;
  output.write(`${JSON.stringify(payload, null, 2)}\n`);
  runOperationReportTail({
    clumpRoot,
    repoRoot: repoRoot(),
    verb,
    argv,
    ok,
    payload,
    log,
  });
}

main().catch((e) => {
  errout.write(`[proxmox] teardown fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.exitCode = 1;
});
