import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { servicesPackagesDir } from "hdc/package/clumps-root.mjs";

import { tryLoadClumpConfigFromClumpRoot } from "hdc/cli/lib/clump-config.mjs";
import { repoRoot as defaultRepoRoot } from "hdc/cli/paths.mjs";
import {
  clusterConfigByKey,
  isProxmoxConfigObject,
  loadProxmoxHostsByCluster,
} from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  proxmoxMaintainVerifyPaths,
} from "./proxmox-deploy-auth.mjs";
import {
  fetchClusterVmResources,
  locateVmidInCluster,
} from "./proxmox-host-provisioner.mjs";
import { locateGuestByNameInCluster } from "./proxmox-backup-maintain.mjs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { lxcTemplateStorageFromConfig } from "./proxmox-provision-config.mjs";
import { ensureGuestPackageTag, proxmoxGuestTypeFromMode } from "./proxmox-guest-tags.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function shallowMergeObjects(a, b) {
  const left = isObject(a) ? { ...a } : {};
  const right = isObject(b) ? { ...b } : {};
  return { ...left, ...right };
}

/**
 * @param {unknown} cfg
 */
export function guestTagsMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const guestTags = provision.guest_tags;
  if (!isObject(guestTags)) return true;
  return guestTags.enabled !== false && guestTags.enabled !== 0;
}

/**
 * @param {unknown} cfg
 */
export function guestTagsManageFromDeployments(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const guestTags = provision.guest_tags;
  if (!isObject(guestTags)) return true;
  return guestTags.manage_from_deployments !== false && guestTags.manage_from_deployments !== 0;
}

/**
 * @param {unknown} deployment
 * @param {unknown} defaults
 * @param {string} clumpId
 * @returns {{
 *   systemId: string;
 *   hostId: string;
 *   guestType: "lxc"|"qemu";
 *   vmid: number | null;
 *   lookupName: string;
 * } | null}
 */
export function deploymentTagRow(deployment, defaults, clumpId) {
  if (!isObject(deployment)) return null;

  const systemId = typeof deployment.system_id === "string" ? deployment.system_id.trim() : "";
  const mode =
    (typeof deployment.mode === "string" && deployment.mode.trim()) ||
    (isObject(defaults) && typeof defaults.mode === "string" ? defaults.mode.trim() : "");
  const guestType = proxmoxGuestTypeFromMode(mode);
  if (!guestType) return null;

  const defPx = isObject(defaults) && isObject(defaults.proxmox) ? defaults.proxmox : null;
  const depPx = isObject(deployment.proxmox) ? deployment.proxmox : null;
  if (!depPx && !defPx) return null;

  const mergedPx = shallowMergeObjects(defPx, depPx);
  const hostId = typeof mergedPx.host_id === "string" ? mergedPx.host_id.trim() : "";
  if (!hostId) return null;

  const block =
    guestType === "lxc" && isObject(mergedPx.lxc)
      ? shallowMergeObjects(isObject(defPx?.lxc) ? defPx.lxc : null, mergedPx.lxc)
      : isObject(mergedPx.qemu)
        ? shallowMergeObjects(isObject(defPx?.qemu) ? defPx.qemu : null, mergedPx.qemu)
        : null;
  if (!isObject(block)) return null;

  /** @type {number | null} */
  let vmid = null;
  if (typeof block.vmid === "number" && block.vmid > 0) vmid = block.vmid;

  const lookupName =
    (typeof deployment.hostname === "string" && deployment.hostname.trim()) ||
    (typeof block.hostname === "string" && block.hostname.trim()) ||
    (typeof block.name === "string" && block.name.trim()) ||
    systemId;

  if (!clumpId.trim()) return null;

  return {
    systemId: systemId || lookupName,
    hostId,
    guestType,
    vmid,
    lookupName,
  };
}

/**
 * @param {string} root
 */
export function collectTagTargetsFromPackages(root) {
  /** @type {Map<string, ReturnType<typeof deploymentTagRow> & { clumpId: string }>} */
  const bySystem = new Map();
  const servicesDir = servicesPackagesDir();
  let entries = [];
  try {
    entries = readdirSync(servicesDir);
  } catch {
    return [];
  }

  for (const pkgId of entries) {
    const pkgRoot = join(servicesDir, pkgId);
    try {
      if (!statSync(pkgRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    const exampleRel = `clumps/services/${pkgId}/config.example.json`;
    const loaded = tryLoadClumpConfigFromClumpRoot(pkgRoot, { exampleRel });
    if (!loaded || !isObject(loaded.data)) continue;

    const defaults = loaded.data.defaults ?? null;
    /** @type {Record<string, unknown>[]} */
    const rows = [];
    if (Array.isArray(loaded.data.deployments)) {
      for (const d of loaded.data.deployments) {
        if (isObject(d)) rows.push(d);
      }
    }
    if (Array.isArray(loaded.data.deployment_groups)) {
      for (const g of loaded.data.deployment_groups) {
        if (!isObject(g) || !Array.isArray(g.deployments)) continue;
        for (const d of g.deployments) {
          if (isObject(d)) rows.push(d);
        }
      }
    }
    if (!rows.length && isObject(loaded.data.deploy) && isObject(loaded.data.proxmox)) {
      rows.push({
        system_id: loaded.data.deploy.system_id,
        mode: loaded.data.deploy.mode,
        proxmox: loaded.data.proxmox,
      });
    }

    for (const d of rows) {
      const row = deploymentTagRow(d, defaults, pkgId);
      if (!row) continue;
      bySystem.set(row.systemId, { ...row, clumpId: pkgId });
    }
  }

  return [...bySystem.values()];
}

/**
 * @param {unknown} cfg
 */
function hostIdToClusterKeyFromConfig(cfg) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!isProxmoxConfigObject(cfg)) return map;
  for (const cluster of cfg.clusters) {
    if (!isObject(cluster)) continue;
    const clusterKey = typeof cluster.id === "string" ? cluster.id.trim() : "";
    if (!clusterKey) continue;
    const hosts = cluster.hosts;
    if (!Array.isArray(hosts)) continue;
    for (const h of hosts) {
      if (!isObject(h)) continue;
      const id = typeof h.id === "string" ? h.id.trim() : "";
      if (id) map.set(id, clusterKey);
    }
  }
  return map;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string} [opts.repoRoot]
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 */
export async function runProxmoxGuestTagsMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, vault } = opts;
  const root = opts.repoRoot || defaultRepoRoot();
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "Guest tags maintain");
  if (!loaded) {
    return { ok: true, skipped: false, results: [] };
  }
  const cfg = loaded.data;

  if (!guestTagsMaintainEnabledFromConfig(cfg)) {
    log("guest tags maintain: disabled in provision.guest_tags.enabled — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  if (!guestTagsManageFromDeployments(cfg)) {
    log("guest tags maintain: manage_from_deployments false — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  const targets = collectTagTargetsFromPackages(root);
  if (!targets.length) {
    warn("guest tags maintain: no tag targets found in service clump configs — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  log(`guest tags maintain: ${targets.length} target(s)${dryRun ? " [dry-run]" : ""}.`);

  const configPath = join(clumpRoot, "config.json");
  const configRel = "clumps/infrastructure/proxmox/config.json";
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });
  const hostCluster = hostIdToClusterKeyFromConfig(cfg);
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    warn(`guest tags maintain: no hypervisors in ${configRel}.`);
    return { ok: false, skipped: false, results: [] };
  }

  const lxcStorage = lxcTemplateStorageFromConfig(cfg);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  for (const clusterKey of clusterKeys) {
    const members = byCluster.get(clusterKey);
    if (!members?.length) continue;

    const clusterTargets = targets.filter((t) => hostCluster.get(t.hostId) === clusterKey);
    if (!clusterTargets.length) continue;

    const lead = members[0];
    log(`Cluster ${JSON.stringify(clusterKey)}: reconcile ${clusterTargets.length} guest package tag(s) …`);

    const configCluster = clusterConfigByKey(cfg, clusterKey);
    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn,
      log,
      configCluster,
      verifyPaths: proxmoxMaintainVerifyPaths(lead.pveNode, lxcStorage),
    });
    if (!auth) {
      ok = false;
      warn(`Skipping cluster ${JSON.stringify(clusterKey)} — no API token.`);
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    let resources = [];
    try {
      resources = await fetchClusterVmResources(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
      );
    } catch (e) {
      ok = false;
      warn(`Cluster ${JSON.stringify(clusterKey)} API read failed: ${/** @type {Error} */ (e).message || e}`);
      continue;
    }

    for (const target of clusterTargets) {
      /** @type {Record<string, unknown>} */
      const row = {
        systemId: target.systemId,
        clumpId: target.clumpId,
        hostId: target.hostId,
        guestType: target.guestType,
        clusterKey,
      };

      let vmid = target.vmid;
      let node = "";
      if (vmid === null) {
        const located = locateGuestByNameInCluster(resources, target.lookupName);
        if (!located) {
          warn(`[${target.systemId}] guest ${JSON.stringify(target.lookupName)} not found — skip.`);
          row.ok = false;
          row.action = "skipped";
          results.push(row);
          continue;
        }
        if (located.template) {
          warn(`[${target.systemId}] ${JSON.stringify(target.lookupName)} is a template — skip.`);
          row.ok = false;
          row.action = "skipped";
          results.push(row);
          continue;
        }
        vmid = located.vmid;
        node = located.node;
      } else {
        const located = locateVmidInCluster(resources, vmid);
        if (!located) {
          warn(`[${target.systemId}] vmid ${vmid} not found — skip.`);
          row.ok = false;
          row.action = "skipped";
          results.push(row);
          continue;
        }
        if (located.template) {
          warn(`[${target.systemId}] vmid ${vmid} is a template — skip.`);
          row.ok = false;
          row.action = "skipped";
          results.push(row);
          continue;
        }
        node = located.node;
      }

      row.vmid = vmid;
      row.desired = { tag: target.clumpId };

      if (dryRun) {
        log(
          `[${target.systemId}] [dry-run] would ensure ${target.guestType} ${vmid} tag ${JSON.stringify(target.clumpId)}`,
        );
        row.ok = true;
        row.action = "dry-run";
        results.push(row);
        continue;
      }

      try {
        const applied = await ensureGuestPackageTag({
          guestType: target.guestType,
          apiBase: auth.host.apiBase,
          authorization: auth.authorization,
          rejectUnauthorized: auth.rejectUnauthorized,
          node,
          vmid,
          clumpId: target.clumpId,
          log: (line) => log(`[${target.systemId}] ${line}`),
        });
        row.ok = applied.ok;
        row.action = applied.changed ? "updated" : "unchanged";
        row.changed = applied.changed;
        results.push(row);
      } catch (e) {
        ok = false;
        row.ok = false;
        row.action = "error";
        row.error = String(/** @type {Error} */ (e).message || e);
        warn(`[${target.systemId}] tag apply failed: ${row.error}`);
        results.push(row);
      }
    }
  }

  return { ok, skipped: false, results };
}
