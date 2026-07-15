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
import { fetchClusterVmResources } from "./proxmox-host-provisioner.mjs";
import {
  hostIdToClusterKeyFromConfig,
  locateGuestByNameInCluster,
} from "./proxmox-backup-maintain.mjs";
import { fetchPveStorageList } from "./proxmox-storage-maintain.mjs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { lxcTemplateStorageFromConfig } from "./proxmox-provision-config.mjs";
import { pveFormBody, pveJsonRequest, pveDataArray, pveData } from "./pve-http.mjs";

const DISK_CONFIG_KEY = /^(?:scsi|virtio|ide|sata|efidisk)\d+$|^rootfs$|^mp\d+$/;

/** Proxmox pvesr supports ZFS local storage only (not lvmthin). */
export const REPLICATION_SUPPORTED_STORAGE_TYPES = new Set(["zfs", "zfspool"]);

/** @typedef {{ schedule: string; rate?: number }} ReplicationProfileSpec */

export const DEFAULT_REPLICATION_PROFILES = {
  frequent: { schedule: "*/15" },
  hourly: { schedule: "*/00" },
  daily: { schedule: "daily" },
};

const DEFAULT_DEFAULT_PROFILE = "frequent";
const DEFAULT_JOB_SUFFIX = 0;

const REPLICATION_COMPARE_KEYS = ["type", "target", "schedule", "rate", "comment", "disable"];

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} systemId
 */
export function hdcManagedReplicationComment(systemId) {
  return `hdc-managed: ${systemId}`;
}

/**
 * @param {unknown} comment
 * @param {string} [systemId]
 */
export function isHdcManagedReplicationComment(comment, systemId) {
  const c = String(comment ?? "").trim();
  if (!c.startsWith("hdc-managed:")) return false;
  if (!systemId) return true;
  return c === hdcManagedReplicationComment(systemId);
}

/**
 * @param {unknown} cfg
 */
export function replicationMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const replication = provision.replication;
  if (!isObject(replication)) return true;
  return replication.enabled !== false && replication.enabled !== 0;
}

/**
 * @param {unknown} cfg
 */
export function replicationManageFromDeployments(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const replication = provision.replication;
  if (!isObject(replication)) return true;
  return replication.manage_from_deployments !== false && replication.manage_from_deployments !== 0;
}

/**
 * @param {unknown} cfg
 * @returns {Record<string, ReplicationProfileSpec>}
 */
export function replicationProfilesFromConfig(cfg) {
  /** @type {Record<string, ReplicationProfileSpec>} */
  const merged = { ...DEFAULT_REPLICATION_PROFILES };
  if (!isProxmoxConfigObject(cfg)) return merged;
  const provision = cfg.provision;
  if (!isObject(provision)) return merged;
  const replication = provision.replication;
  if (!isObject(replication)) return merged;
  const profiles = replication.profiles;
  if (!isObject(profiles)) return merged;
  for (const [name, spec] of Object.entries(profiles)) {
    if (!isObject(spec)) continue;
    const base = merged[name] ?? DEFAULT_REPLICATION_PROFILES.frequent;
    /** @type {ReplicationProfileSpec} */
    const next = {
      schedule:
        typeof spec.schedule === "string" && spec.schedule.trim() ? spec.schedule.trim() : base.schedule,
    };
    if (typeof spec.rate === "number" && spec.rate > 0) next.rate = spec.rate;
    else if (typeof base.rate === "number" && base.rate > 0) next.rate = base.rate;
    merged[name] = next;
  }
  return merged;
}

/**
 * @param {unknown} cfg
 */
export function replicationDefaultProfileFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return DEFAULT_DEFAULT_PROFILE;
  const provision = cfg.provision;
  if (!isObject(provision)) return DEFAULT_DEFAULT_PROFILE;
  const replication = provision.replication;
  if (!isObject(replication)) return DEFAULT_DEFAULT_PROFILE;
  const profile = replication.default_profile;
  return typeof profile === "string" && profile.trim() ? profile.trim() : DEFAULT_DEFAULT_PROFILE;
}

/**
 * @param {number} vmid
 * @param {number} [suffix]
 */
export function replicationJobIdForGuest(vmid, suffix = DEFAULT_JOB_SUFFIX) {
  const n = Number(suffix);
  const jobNum = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_JOB_SUFFIX;
  return `${vmid}-${jobNum}`;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function mergeObjects(a, b) {
  const left = isObject(a) ? { ...a } : {};
  const right = isObject(b) ? { ...b } : {};
  return { ...left, ...right };
}

/**
 * @param {unknown} cfg
 * @param {unknown} serviceReplication
 * @returns {{ profile: string; schedule: string; rate?: number; target_host_id: string; job_suffix: number }}
 */
export function resolveReplicationSpec(cfg, serviceReplication) {
  const profiles = replicationProfilesFromConfig(cfg);
  const defaultProfile = replicationDefaultProfileFromConfig(cfg);
  const merged = mergeObjects({}, serviceReplication);
  const profileName =
    typeof merged.profile === "string" && merged.profile.trim() ? merged.profile.trim() : defaultProfile;
  const profile = profiles[profileName] ?? profiles[defaultProfile] ?? DEFAULT_REPLICATION_PROFILES.frequent;
  const targetHostId =
    typeof merged.target_host_id === "string" && merged.target_host_id.trim()
      ? merged.target_host_id.trim()
      : "";
  const jobSuffix =
    typeof merged.job_suffix === "number" && merged.job_suffix >= 0
      ? Math.floor(merged.job_suffix)
      : DEFAULT_JOB_SUFFIX;
  /** @type {{ profile: string; schedule: string; rate?: number; target_host_id: string; job_suffix: number }} */
  const spec = {
    profile: profileName,
    schedule:
      typeof merged.schedule === "string" && merged.schedule.trim() ? merged.schedule.trim() : profile.schedule,
    target_host_id: targetHostId,
    job_suffix: jobSuffix,
  };
  const rate =
    typeof merged.rate === "number" && merged.rate > 0
      ? merged.rate
      : typeof profile.rate === "number" && profile.rate > 0
        ? profile.rate
        : undefined;
  if (rate !== undefined) spec.rate = rate;
  return spec;
}

/**
 * @param {unknown} deployment
 * @param {unknown} defaultsReplication
 * @returns {{
 *   systemId: string;
 *   hostId: string;
 *   vmid: number | null;
 *   lookupName: string;
 *   serviceReplication: Record<string, unknown>;
 * } | null}
 */
export function deploymentReplicationRow(deployment, defaultsReplication) {
  if (!isObject(deployment)) return null;
  const systemId = typeof deployment.system_id === "string" ? deployment.system_id.trim() : "";
  const px = isObject(deployment.proxmox) ? deployment.proxmox : null;
  if (!px) return null;
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return null;

  const mergedReplication = mergeObjects(defaultsReplication, deployment.replication);
  if (mergedReplication.enabled !== true && mergedReplication.enabled !== 1) return null;

  const lxc = isObject(px.lxc) ? px.lxc : null;
  const qemu = isObject(px.qemu) ? px.qemu : null;
  /** @type {number | null} */
  let vmid = null;
  if (lxc && typeof lxc.vmid === "number" && lxc.vmid > 0) vmid = lxc.vmid;
  if (qemu && typeof qemu.vmid === "number" && qemu.vmid > 0) vmid = qemu.vmid;

  const lookupName =
    (typeof deployment.hostname === "string" && deployment.hostname.trim()) ||
    (lxc && typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
    (qemu && typeof qemu.hostname === "string" && qemu.hostname.trim()) ||
    systemId;

  return {
    systemId: systemId || lookupName,
    hostId,
    vmid,
    lookupName,
    serviceReplication: mergedReplication,
  };
}

/**
 * @param {string} root
 * @param {unknown} cfg
 */
export function collectReplicationTargetsFromPackages(root, cfg) {
  /** @type {Map<string, { systemId: string; hostId: string; vmid: number | null; lookupName: string; replication: ReturnType<typeof resolveReplicationSpec> }>} */
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
    const defaultsReplication = isObject(loaded.data.defaults) ? loaded.data.defaults.replication : null;
    const deployments = loaded.data.deployments;
    if (!Array.isArray(deployments)) continue;
    for (const d of deployments) {
      const row = deploymentReplicationRow(d, defaultsReplication);
      if (!row) continue;
      row.replication = resolveReplicationSpec(
        cfg,
        mergeObjects(defaultsReplication, isObject(d) ? d.replication : null),
      );
      bySystem.set(row.systemId, {
        systemId: row.systemId,
        hostId: row.hostId,
        vmid: row.vmid,
        lookupName: row.lookupName,
        replication: row.replication,
      });
    }
  }
  return [...bySystem.values()];
}

/**
 * @param {unknown} cfg
 * @returns {Map<string, string>}
 */
export function hostIdToPveNodeFromConfig(cfg) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!isProxmoxConfigObject(cfg)) return map;
  for (const cl of cfg.clusters) {
    if (!isObject(cl) || !Array.isArray(cl.hosts)) continue;
    for (const h of cl.hosts) {
      if (!isObject(h)) continue;
      const id = typeof h.id === "string" ? h.id.trim() : "";
      const node = typeof h.pve_node === "string" ? h.pve_node.trim() : id;
      if (id && node) map.set(id, node);
    }
  }
  return map;
}

/**
 * @param {object} target
 * @param {ReturnType<typeof resolveReplicationSpec>} spec
 * @param {string} targetPveNode
 */
export function buildReplicationJobBody(target, spec, targetPveNode) {
  const id = replicationJobIdForGuest(target.vmid, spec.job_suffix);
  /** @type {Record<string, string | number>} */
  const body = {
    id,
    type: "local",
    target: targetPveNode,
    schedule: spec.schedule,
    comment: hdcManagedReplicationComment(target.systemId),
    disable: 0,
  };
  if (typeof spec.rate === "number" && spec.rate > 0) {
    body.rate = spec.rate;
  }
  return body;
}

/**
 * @param {Record<string, unknown>} desired
 * @param {Record<string, unknown>} live
 */
export function replicationJobsMatch(desired, live) {
  for (const key of REPLICATION_COMPARE_KEYS) {
    const dVal = desired[key];
    const lVal = live[key];
    if (key === "disable") {
      const d = dVal === 0 || dVal === false || dVal === "0";
      const l = lVal === 0 || lVal === false || lVal === "0" || lVal === undefined || lVal === null;
      if (d !== l) return false;
      continue;
    }
    if (key === "rate") {
      const d = dVal === undefined || dVal === null || dVal === "" ? "" : String(dVal).trim();
      const l = lVal === undefined || lVal === null || lVal === "" ? "" : String(lVal).trim();
      if (d !== l) return false;
      continue;
    }
    if (String(dVal ?? "").trim() !== String(lVal ?? "").trim()) return false;
  }
  return true;
}

/**
 * @param {string} diskValue
 * @returns {string | null}
 */
export function appendReplicateFlagToDiskValue(diskValue) {
  const v = String(diskValue ?? "").trim();
  if (!v || /media=cdrom/i.test(v)) return null;
  if (/replicate=1/i.test(v)) return null;
  if (/replicate=0/i.test(v)) return v.replace(/replicate=0/i, "replicate=1");
  return `${v},replicate=1`;
}

/**
 * @param {string} diskValue
 * @returns {string | null}
 */
export function parseStorageIdFromDiskValue(diskValue) {
  const v = String(diskValue ?? "").trim();
  if (!v || /media=cdrom/i.test(v)) return null;
  const colon = v.indexOf(":");
  if (colon <= 0) return null;
  return v.slice(0, colon).trim() || null;
}

/**
 * @param {Record<string, unknown>} guestConfig
 * @returns {string[]}
 */
export function guestDiskStorageIdsFromConfig(guestConfig) {
  /** @type {string[]} */
  const ids = [];
  for (const [key, val] of Object.entries(guestConfig)) {
    if (!DISK_CONFIG_KEY.test(key)) continue;
    if (typeof val !== "string") continue;
    const storageId = parseStorageIdFromDiskValue(val);
    if (storageId) ids.push(storageId);
  }
  return [...new Set(ids)];
}

/**
 * @param {Record<string, unknown>[]} storageRows
 * @param {string} storageId
 * @returns {string | null}
 */
export function storageTypeForId(storageRows, storageId) {
  const row = storageRows.find((r) => r.storage === storageId);
  const type = row && typeof row.type === "string" ? row.type.trim() : "";
  return type || null;
}

/**
 * @param {string | null | undefined} storageType
 */
export function storageTypeSupportsReplication(storageType) {
  return REPLICATION_SUPPORTED_STORAGE_TYPES.has(String(storageType ?? "").trim());
}

/**
 * @param {object} auth
 * @param {string} node
 * @param {string} guestType
 * @param {number} vmid
 * @param {Record<string, unknown>[]} storageRows
 * @returns {Promise<{ ok: true } | { ok: false; error: string; storageIds?: string[]; storageTypes?: Record<string, string | null> }>}
 */
export async function validateGuestStorageForReplication(auth, node, guestType, vmid, storageRows) {
  const guestPath =
    guestType === "lxc"
      ? `/nodes/${encodeURIComponent(node)}/lxc/${vmid}/config`
      : `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`;
  const body = await pveJsonRequest(
    "GET",
    auth.host.apiBase,
    guestPath,
    auth.authorization,
    auth.rejectUnauthorized,
    undefined,
  );
  const data = pveData(body);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "guest config unreadable" };
  }
  const storageIds = guestDiskStorageIdsFromConfig(data);
  if (!storageIds.length) {
    return { ok: false, error: "no disk volumes found in guest config" };
  }
  /** @type {Record<string, string | null>} */
  const storageTypes = {};
  /** @type {string[]} */
  const unsupported = [];
  for (const storageId of storageIds) {
    const type = storageTypeForId(storageRows, storageId);
    storageTypes[storageId] = type;
    if (!storageTypeSupportsReplication(type)) unsupported.push(storageId);
  }
  if (unsupported.length) {
    const detail = unsupported
      .map((id) => `${id} (${storageTypes[id] ?? "unknown type"})`)
      .join(", ");
    return {
      ok: false,
      error: `storage not supported for pvesr replication (${detail}); migrate disks to ZFS (zfspool) storage`,
      storageIds,
      storageTypes,
    };
  }
  return { ok: true };
}

/**
 * @param {object} auth
 * @param {string} node
 * @param {string} guestType
 * @param {number} vmid
 * @param {(line: string) => void} log
 * @param {boolean} dryRun
 */
export async function ensureGuestVolumesReplicateEnabled(auth, node, guestType, vmid, log, dryRun) {
  const guestPath =
    guestType === "lxc"
      ? `/nodes/${encodeURIComponent(node)}/lxc/${vmid}/config`
      : `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`;
  const body = await pveJsonRequest(
    "GET",
    auth.host.apiBase,
    guestPath,
    auth.authorization,
    auth.rejectUnauthorized,
    undefined,
  );
  const data = pveData(body);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "guest config unreadable" };
  }
  /** @type {Record<string, string>} */
  const updates = {};
  for (const [key, val] of Object.entries(data)) {
    if (!DISK_CONFIG_KEY.test(key)) continue;
    if (typeof val !== "string") continue;
    const next = appendReplicateFlagToDiskValue(val);
    if (next) updates[key] = next;
  }
  if (!Object.keys(updates).length) {
    return { ok: true, changed: false };
  }
  const keys = Object.keys(updates).join(", ");
  if (dryRun) {
    log(`vmid ${vmid} on ${node}: would enable replicate on ${keys}`);
    return { ok: true, changed: true, dryRun: true, keys: keys.split(", ") };
  }
  await pveJsonRequest(
    "PUT",
    auth.host.apiBase,
    guestPath,
    auth.authorization,
    auth.rejectUnauthorized,
    pveFormBody(updates),
  );
  log(`vmid ${vmid} on ${node}: enabled replicate on ${keys}.`);
  return { ok: true, changed: true, keys: keys.split(", ") };
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function fetchPveReplicationJobs(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    "/cluster/replication",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  return pveDataArray(body);
}

/**
 * @param {Record<string, unknown>[]} resources
 * @param {number} vmid
 * @returns {{ vmid: number; node: string; type: string; template: boolean } | null}
 */
export function locateGuestVmidInCluster(resources, vmid) {
  for (const r of resources) {
    if (typeof r.vmid !== "number" || r.vmid !== vmid) continue;
    const node = typeof r.node === "string" ? r.node.trim() : "";
    if (!node) continue;
    const type = typeof r.type === "string" ? r.type.trim() : "qemu";
    return {
      vmid: r.vmid,
      node,
      type,
      template: r.template === 1 || r.template === true,
    };
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string} [opts.repoRoot]
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.prune
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 */
export async function runProxmoxReplicationMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, prune, vault } = opts;
  const root = opts.repoRoot || defaultRepoRoot();
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "Replication maintain");
  if (!loaded) {
    return { ok: true, skipped: false, results: [] };
  }
  const cfg = loaded.data;

  if (!replicationMaintainEnabledFromConfig(cfg)) {
    log("replication maintain: disabled in provision.replication.enabled — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  if (!replicationManageFromDeployments(cfg)) {
    log("replication maintain: manage_from_deployments false — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  const hostCluster = hostIdToClusterKeyFromConfig(cfg);
  const hostToNode = hostIdToPveNodeFromConfig(cfg);
  const targets = collectReplicationTargetsFromPackages(root, cfg);

  if (!targets.length) {
    warn("replication maintain: no replication targets found in service package deployments — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  log(
    `replication maintain: ${targets.length} target(s)${dryRun ? " [dry-run]" : ""}${prune ? " [prune]" : ""}.`,
  );

  const configPath = join(clumpRoot, "config.json");
  const configRel = "clumps/infrastructure/proxmox/config.json";
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    warn(`replication maintain: no hypervisors in ${configRel}.`);
    return { ok: false, skipped: false, results: [] };
  }

  const lxcStorage = lxcTemplateStorageFromConfig(cfg);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  /** @type {Set<string>} */
  const desiredJobIds = new Set();

  for (const clusterKey of clusterKeys) {
    const members = byCluster.get(clusterKey);
    if (!members?.length) continue;

    const clusterTargets = targets.filter((t) => hostCluster.get(t.hostId) === clusterKey);
    if (!clusterTargets.length) continue;

    const lead = members[0];
    log(`Cluster ${JSON.stringify(clusterKey)}: reconcile ${clusterTargets.length} replication job(s) …`);

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
    /** @type {Record<string, unknown>[]} */
    let liveJobs = [];
    /** @type {Record<string, unknown>[]} */
    let storageRows = [];
    try {
      [resources, liveJobs, storageRows] = await Promise.all([
        fetchClusterVmResources(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
        fetchPveReplicationJobs(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
        fetchPveStorageList(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
      ]);
    } catch (e) {
      ok = false;
      warn(`Cluster ${JSON.stringify(clusterKey)} API read failed: ${/** @type {Error} */ (e).message || e}`);
      continue;
    }

    const liveById = new Map(
      liveJobs.filter((j) => typeof j.id === "string").map((j) => [String(j.id), j]),
    );

    for (const target of clusterTargets) {
      /** @type {Record<string, unknown>} */
      const row = {
        systemId: target.systemId,
        hostId: target.hostId,
        profile: target.replication.profile,
        clusterKey,
      };

      const targetHostId = target.replication.target_host_id;
      if (!targetHostId) {
        warn(`[${target.systemId}] replication.target_host_id missing — skip.`);
        row.ok = false;
        row.action = "skipped";
        row.error = "missing target_host_id";
        results.push(row);
        continue;
      }
      if (targetHostId === target.hostId) {
        warn(`[${target.systemId}] replication target ${JSON.stringify(targetHostId)} equals source — skip.`);
        row.ok = false;
        row.action = "skipped";
        row.error = "target equals source";
        results.push(row);
        continue;
      }
      const targetPveNode = hostToNode.get(targetHostId);
      if (!targetPveNode) {
        warn(`[${target.systemId}] unknown replication target_host_id ${JSON.stringify(targetHostId)} — skip.`);
        row.ok = false;
        row.action = "skipped";
        row.error = "unknown target_host_id";
        results.push(row);
        continue;
      }
      if (hostCluster.get(targetHostId) !== clusterKey) {
        warn(
          `[${target.systemId}] replication target ${JSON.stringify(targetHostId)} not in same cluster — skip.`,
        );
        row.ok = false;
        row.action = "skipped";
        row.error = "target outside cluster";
        results.push(row);
        continue;
      }

      let vmid = target.vmid;
      /** @type {string} */
      let guestType = "qemu";
      if (vmid === null) {
        const located = locateGuestByNameInCluster(resources, target.lookupName);
        if (!located) {
          warn(`[${target.systemId}] guest ${JSON.stringify(target.lookupName)} not found in cluster — skip.`);
          row.ok = false;
          row.action = "skipped";
          row.error = "guest not found";
          results.push(row);
          continue;
        }
        if (located.template) {
          warn(`[${target.systemId}] ${JSON.stringify(target.lookupName)} is a template — skip.`);
          row.ok = false;
          row.action = "skipped";
          row.error = "template guest";
          results.push(row);
          continue;
        }
        vmid = located.vmid;
        const full = locateGuestVmidInCluster(resources, vmid);
        if (full?.type) guestType = full.type;
      } else {
        const located = locateGuestVmidInCluster(resources, vmid);
        if (!located) {
          warn(`[${target.systemId}] vmid ${vmid} not found in cluster — skip.`);
          row.ok = false;
          row.action = "skipped";
          row.error = "vmid not found";
          results.push(row);
          continue;
        }
        if (located.template) {
          warn(`[${target.systemId}] vmid ${vmid} is a template — skip.`);
          row.ok = false;
          row.action = "skipped";
          row.error = "template guest";
          results.push(row);
          continue;
        }
        guestType = located.type;
      }

      row.vmid = vmid;
      row.guestType = guestType;
      row.targetHostId = targetHostId;
      row.targetPveNode = targetPveNode;

      const sourceNode = locateGuestVmidInCluster(resources, vmid)?.node ?? hostToNode.get(target.hostId);
      if (!sourceNode) {
        warn(`[${target.systemId}] source node unknown for vmid ${vmid} — skip.`);
        row.ok = false;
        row.action = "skipped";
        row.error = "source node unknown";
        results.push(row);
        continue;
      }
      row.sourceNode = sourceNode;

      const resolvedTarget = { ...target, vmid };
      const desired = buildReplicationJobBody(resolvedTarget, target.replication, targetPveNode);
      const jobId = String(desired.id);
      desiredJobIds.add(jobId);
      row.id = jobId;

      const live = liveById.get(jobId);
      if (live && replicationJobsMatch(desired, live)) {
        log(`[${target.systemId}] replication job ${JSON.stringify(jobId)} OK.`);
        row.ok = true;
        row.action = "unchanged";
        results.push(row);
        continue;
      }

      if (live) {
        log(
          `[${target.systemId}] replication job ${JSON.stringify(jobId)} differs — will update${dryRun ? " [dry-run]" : ""}.`,
        );
        row.action = "update";
      } else {
        log(
          `[${target.systemId}] replication job ${JSON.stringify(jobId)} missing — will create${dryRun ? " [dry-run]" : ""}.`,
        );
        row.action = "create";
      }

      if (dryRun) {
        try {
          const storageCheck = await validateGuestStorageForReplication(
            auth,
            sourceNode,
            guestType,
            vmid,
            storageRows,
          );
          if (!storageCheck.ok) {
            warn(`[${target.systemId}] ${storageCheck.error}`);
            row.ok = false;
            row.error = storageCheck.error;
            ok = false;
            results.push(row);
            continue;
          }
          await ensureGuestVolumesReplicateEnabled(
            auth,
            sourceNode,
            guestType,
            vmid,
            log,
            true,
          );
        } catch (e) {
          warn(
            `[${target.systemId}] replicate volume check failed: ${/** @type {Error} */ (e).message || e}`,
          );
        }
        row.ok = true;
        results.push(row);
        continue;
      }

      try {
        const storageCheck = await validateGuestStorageForReplication(
          auth,
          sourceNode,
          guestType,
          vmid,
          storageRows,
        );
        if (!storageCheck.ok) {
          warn(`[${target.systemId}] ${storageCheck.error}`);
          ok = false;
          row.ok = false;
          row.error = storageCheck.error;
          results.push(row);
          continue;
        }
        const vol = await ensureGuestVolumesReplicateEnabled(
          auth,
          sourceNode,
          guestType,
          vmid,
          log,
          false,
        );
        if (!vol.ok) {
          ok = false;
          row.ok = false;
          row.error = vol.error || "replicate volume enable failed";
          results.push(row);
          continue;
        }
        row.replicateVolumes = vol;
      } catch (e) {
        ok = false;
        const err = /** @type {Error} */ (e).message || String(e);
        warn(`[${target.systemId}] replicate volume enable failed: ${err}`);
        row.ok = false;
        row.error = err;
        results.push(row);
        continue;
      }

      try {
        const form = pveFormBody(desired);
        if (live) {
          await pveJsonRequest(
            "PUT",
            auth.host.apiBase,
            `/cluster/replication/${encodeURIComponent(jobId)}`,
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
        } else {
          await pveJsonRequest(
            "POST",
            auth.host.apiBase,
            "/cluster/replication",
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
        }
        log(`[${target.systemId}] replication job ${JSON.stringify(jobId)} ${live ? "updated" : "created"}.`);
        row.ok = true;
      } catch (e) {
        ok = false;
        const err = /** @type {Error} */ (e).message || String(e);
        warn(`[${target.systemId}] replication job ${JSON.stringify(jobId)} failed: ${err}`);
        row.ok = false;
        row.error = err;
      }
      results.push(row);
    }

    if (prune) {
      for (const job of liveJobs) {
        const id = typeof job.id === "string" ? job.id.trim() : "";
        const comment = typeof job.comment === "string" ? job.comment.trim() : "";
        if (!isHdcManagedReplicationComment(comment)) continue;
        if (desiredJobIds.has(id)) continue;
        log(`replication job ${JSON.stringify(id)} stale — will delete${dryRun ? " [dry-run]" : ""}.`);
        /** @type {Record<string, unknown>} */
        const row = { id, action: "delete", clusterKey, comment };
        if (dryRun) {
          row.ok = true;
          results.push(row);
          continue;
        }
        try {
          await pveJsonRequest(
            "DELETE",
            auth.host.apiBase,
            `/cluster/replication/${encodeURIComponent(id)}`,
            auth.authorization,
            auth.rejectUnauthorized,
            undefined,
          );
          log(`replication job ${JSON.stringify(id)} deleted.`);
          row.ok = true;
        } catch (e) {
          ok = false;
          const err = /** @type {Error} */ (e).message || String(e);
          warn(`replication job ${JSON.stringify(id)} delete failed: ${err}`);
          row.ok = false;
          row.error = err;
        }
        results.push(row);
      }
    }
  }

  return { ok, skipped: false, results };
}
