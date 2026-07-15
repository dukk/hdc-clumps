import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { servicesPackagesDir } from "hdc/package/clumps-root.mjs";

import { tryLoadClumpConfigFromClumpRoot } from "hdc/cli/lib/clump-config.mjs";
import { repoRoot as defaultRepoRoot } from "hdc/cli/paths.mjs";
import {
  hostIdToClusterKeyFromConfig,
  locateGuestByNameInCluster,
} from "./proxmox-backup-maintain.mjs";
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
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { lxcTemplateStorageFromConfig } from "./proxmox-provision-config.mjs";
import {
  collectReplicationTargetsFromPackages,
  hostIdToPveNodeFromConfig,
  locateGuestVmidInCluster,
} from "./proxmox-replication-maintain.mjs";
import { pveFormBody, pveJsonRequest, pveDataArray } from "./pve-http.mjs";
import { resolveClusterPveProfile } from "./pve-version.mjs";

const HA_RULE_COMPARE_KEYS = ["type", "nodes", "resources", "strict", "comment"];

/** @typedef {{ state: string; max_restart: number; max_relocate: number; group: string }} HaDefaultsSpec */

/** @typedef {{ nodes: string[]; restricted?: boolean; nofailback?: boolean; comment?: string }} HaGroupSpec */

export const DEFAULT_HA_DEFAULTS = {
  state: "started",
  max_restart: 3,
  max_relocate: 2,
  group: "",
};

const HA_RESOURCE_COMPARE_KEYS = ["state", "group", "max_restart", "max_relocate", "comment"];
const HA_GROUP_COMPARE_KEYS = ["nodes", "restricted", "nofailback", "comment"];

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} systemId
 */
export function hdcManagedHaComment(systemId) {
  return `hdc-managed: ${systemId}`;
}

/**
 * @param {unknown} comment
 * @param {string} [systemId]
 */
export function isHdcManagedHaComment(comment, systemId) {
  const c = String(comment ?? "").trim();
  if (!c.startsWith("hdc-managed:")) return false;
  if (!systemId) return true;
  return c === hdcManagedHaComment(systemId);
}

/**
 * @param {string} guestType qemu | lxc
 * @param {number} vmid
 */
export function haResourceSid(guestType, vmid) {
  const t = guestType === "lxc" ? "ct" : "vm";
  return `${t}:${vmid}`;
}

/**
 * @param {unknown} cfg
 */
export function haMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const ha = provision.ha;
  if (!isObject(ha)) return true;
  return ha.enabled !== false && ha.enabled !== 0;
}

/**
 * @param {unknown} cfg
 */
export function haManageFromDeployments(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const ha = provision.ha;
  if (!isObject(ha)) return true;
  return ha.manage_from_deployments !== false && ha.manage_from_deployments !== 0;
}

/**
 * @param {unknown} cfg
 * @returns {Record<string, HaGroupSpec>}
 */
export function haGroupsFromConfig(cfg) {
  /** @type {Record<string, HaGroupSpec>} */
  const out = {};
  if (!isProxmoxConfigObject(cfg)) return out;
  const provision = cfg.provision;
  if (!isObject(provision)) return out;
  const ha = provision.ha;
  if (!isObject(ha)) return out;
  const groups = ha.groups;
  if (!isObject(groups)) return out;
  for (const [id, spec] of Object.entries(groups)) {
    if (!isObject(spec)) continue;
    const nodesRaw = spec.nodes;
    /** @type {string[]} */
    const nodes = [];
    if (Array.isArray(nodesRaw)) {
      for (const n of nodesRaw) {
        if (typeof n === "string" && n.trim()) nodes.push(n.trim());
      }
    }
    if (!nodes.length) continue;
    out[id] = {
      nodes,
      restricted: spec.restricted === true || spec.restricted === 1,
      nofailback: spec.nofailback === true || spec.nofailback === 1,
      comment:
        typeof spec.comment === "string" && spec.comment.trim() ? spec.comment.trim() : undefined,
    };
  }
  return out;
}

/**
 * @param {unknown} cfg
 * @returns {HaDefaultsSpec}
 */
export function haDefaultsFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return { ...DEFAULT_HA_DEFAULTS };
  const provision = cfg.provision;
  if (!isObject(provision)) return { ...DEFAULT_HA_DEFAULTS };
  const ha = provision.ha;
  if (!isObject(ha)) return { ...DEFAULT_HA_DEFAULTS };
  const defaults = ha.defaults;
  if (!isObject(defaults)) return { ...DEFAULT_HA_DEFAULTS };
  return {
    state:
      typeof defaults.state === "string" && defaults.state.trim()
        ? defaults.state.trim()
        : DEFAULT_HA_DEFAULTS.state,
    max_restart:
      typeof defaults.max_restart === "number" && defaults.max_restart >= 0
        ? Math.floor(defaults.max_restart)
        : DEFAULT_HA_DEFAULTS.max_restart,
    max_relocate:
      typeof defaults.max_relocate === "number" && defaults.max_relocate >= 0
        ? Math.floor(defaults.max_relocate)
        : DEFAULT_HA_DEFAULTS.max_relocate,
    group: typeof defaults.group === "string" ? defaults.group.trim() : DEFAULT_HA_DEFAULTS.group,
  };
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
 * @param {unknown} serviceHa
 * @returns {HaDefaultsSpec & { enabled: boolean }}
 */
export function resolveHaSpec(cfg, serviceHa) {
  const defaults = haDefaultsFromConfig(cfg);
  const merged = mergeObjects({}, serviceHa);
  if (merged.enabled !== true && merged.enabled !== 1) {
    return { ...defaults, enabled: false, group: defaults.group };
  }
  return {
    enabled: true,
    state: typeof merged.state === "string" && merged.state.trim() ? merged.state.trim() : defaults.state,
    max_restart:
      typeof merged.max_restart === "number" && merged.max_restart >= 0
        ? Math.floor(merged.max_restart)
        : defaults.max_restart,
    max_relocate:
      typeof merged.max_relocate === "number" && merged.max_relocate >= 0
        ? Math.floor(merged.max_relocate)
        : defaults.max_relocate,
    group:
      typeof merged.group === "string" && merged.group.trim()
        ? merged.group.trim()
        : defaults.group,
  };
}

/**
 * @param {unknown} deployment
 * @param {unknown} defaultsHa
 * @returns {{
 *   systemId: string;
 *   hostId: string;
 *   vmid: number | null;
 *   lookupName: string;
 *   serviceHa: Record<string, unknown>;
 * } | null}
 */
export function deploymentHaRow(deployment, defaultsHa) {
  if (!isObject(deployment)) return null;
  const systemId = typeof deployment.system_id === "string" ? deployment.system_id.trim() : "";
  const px = isObject(deployment.proxmox) ? deployment.proxmox : null;
  if (!px) return null;
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return null;

  const mergedHa = mergeObjects(defaultsHa, deployment.ha);
  const spec = resolveHaSpec({}, mergedHa);
  if (!spec.enabled) return null;

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
    serviceHa: mergedHa,
  };
}

/**
 * @param {string} root
 * @param {unknown} cfg
 */
export function collectHaTargetsFromPackages(root, cfg) {
  /** @type {Map<string, { systemId: string; hostId: string; vmid: number | null; lookupName: string; ha: ReturnType<typeof resolveHaSpec> }>} */
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
    const defaultsHa = isObject(loaded.data.defaults) ? loaded.data.defaults.ha : null;
    const deployments = loaded.data.deployments;
    if (!Array.isArray(deployments)) continue;
    for (const d of deployments) {
      const row = deploymentHaRow(d, defaultsHa);
      if (!row) continue;
      row.ha = resolveHaSpec(cfg, mergeObjects(defaultsHa, isObject(d) ? d.ha : null));
      bySystem.set(row.systemId, {
        systemId: row.systemId,
        hostId: row.hostId,
        vmid: row.vmid,
        lookupName: row.lookupName,
        ha: row.ha,
      });
    }
  }
  return [...bySystem.values()];
}

/**
 * @param {string[]} hostIds
 * @param {Map<string, string>} hostToNode
 * @returns {string}
 */
export function haGroupNodesString(hostIds, hostToNode) {
  /** @type {string[]} */
  const nodes = [];
  for (const id of hostIds) {
    const node = hostToNode.get(id);
    if (node) nodes.push(node);
  }
  return nodes.join(",");
}

/**
 * @param {string} groupId
 * @param {HaGroupSpec} spec
 * @param {Map<string, string>} hostToNode
 */
export function buildHaGroupBody(groupId, spec, hostToNode) {
  const nodes = spec.nodes
    .map((hostId) => hostToNode.get(hostId) ?? hostId)
    .filter(Boolean)
    .join(",");
  return {
    group: groupId,
    nodes,
    restricted: spec.restricted ? 1 : 0,
    nofailback: spec.nofailback ? 1 : 0,
    comment: spec.comment ?? `hdc-managed group ${groupId}`,
  };
}

/**
 * @param {object} target
 * @param {ReturnType<typeof resolveHaSpec>} spec
 * @param {string} guestType
 * @param {{ omitGroup?: boolean }} [opts]
 */
export function buildHaResourceBody(target, spec, guestType, opts = {}) {
  const sid = haResourceSid(guestType, target.vmid);
  /** @type {Record<string, string | number>} */
  const body = {
    sid,
    state: spec.state,
    max_restart: spec.max_restart,
    max_relocate: spec.max_relocate,
    comment: hdcManagedHaComment(target.systemId),
  };
  if (!opts.omitGroup && spec.group) {
    body.group = spec.group;
  }
  return body;
}

/**
 * @param {unknown} value
 */
function normalizeBoolInt(value) {
  return value === 1 || value === true || value === "1" ? 1 : 0;
}

/**
 * @param {Record<string, unknown>} desired
 * @param {Record<string, unknown>} live
 */
export function haGroupsMatch(desired, live) {
  for (const key of HA_GROUP_COMPARE_KEYS) {
    const dVal = desired[key];
    const lVal = live[key];
    if (key === "restricted" || key === "nofailback") {
      if (normalizeBoolInt(dVal) !== normalizeBoolInt(lVal)) return false;
      continue;
    }
    if (key === "nodes") {
      const dNodes = String(dVal ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort()
        .join(",");
      const lNodes = String(lVal ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort()
        .join(",");
      if (dNodes !== lNodes) return false;
      continue;
    }
    if (String(dVal ?? "").trim() !== String(lVal ?? "").trim()) return false;
  }
  return true;
}

/**
 * @param {Record<string, unknown>} desired
 * @param {Record<string, unknown>} live
 */
export function haResourcesMatch(desired, live) {
  for (const key of HA_RESOURCE_COMPARE_KEYS) {
    if (key === "group" && desired.group === undefined) continue;
    const dVal = desired[key];
    const lVal = live[key];
    if (key === "max_restart" || key === "max_relocate") {
      if (String(dVal ?? "").trim() !== String(lVal ?? "").trim()) return false;
      continue;
    }
    if (String(dVal ?? "").trim() !== String(lVal ?? "").trim()) return false;
  }
  return true;
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function fetchPveHaRules(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    "/cluster/ha/rules",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  return pveDataArray(body);
}

/**
 * @param {string} groupId
 * @param {HaGroupSpec} spec
 * @param {Map<string, string>} hostToNode
 * @param {string[]} resourceSids
 */
export function buildHaNodeAffinityRuleBody(groupId, spec, hostToNode, resourceSids) {
  const nodes = spec.nodes
    .map((hostId) => hostToNode.get(hostId) ?? hostId)
    .filter(Boolean)
    .join(",");
  const resources = [...resourceSids].sort().join(",");
  return {
    type: "node-affinity",
    rule: groupId,
    nodes,
    resources,
    strict: spec.restricted ? 1 : 0,
    comment: spec.comment ?? `hdc-managed group ${groupId}`,
  };
}

/**
 * @param {Record<string, unknown>} desired
 * @param {Record<string, unknown>} live
 */
export function haNodeAffinityRulesMatch(desired, live) {
  for (const key of HA_RULE_COMPARE_KEYS) {
    const dVal = desired[key];
    const lVal = live[key];
    if (key === "strict") {
      if (normalizeBoolInt(dVal) !== normalizeBoolInt(lVal)) return false;
      continue;
    }
    if (key === "nodes" || key === "resources") {
      const normalizeList = (v) =>
        String(v ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .sort()
          .join(",");
      if (normalizeList(dVal) !== normalizeList(lVal)) return false;
      continue;
    }
    if (String(dVal ?? "").trim() !== String(lVal ?? "").trim()) return false;
  }
  return true;
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function fetchPveHaGroups(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    "/cluster/ha/groups",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  return pveDataArray(body);
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function fetchPveHaResources(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    "/cluster/ha/resources",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  return pveDataArray(body);
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
export async function runProxmoxHaMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, prune, vault } = opts;
  const root = opts.repoRoot || defaultRepoRoot();
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "HA maintain");
  if (!loaded) {
    return { ok: true, skipped: false, results: [] };
  }
  const cfg = loaded.data;

  if (!haMaintainEnabledFromConfig(cfg)) {
    log("HA maintain: disabled in provision.ha.enabled — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  if (!haManageFromDeployments(cfg)) {
    log("HA maintain: manage_from_deployments false — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  const hostCluster = hostIdToClusterKeyFromConfig(cfg);
  const hostToNode = hostIdToPveNodeFromConfig(cfg);
  const haGroups = haGroupsFromConfig(cfg);
  const targets = collectHaTargetsFromPackages(root, cfg);
  const replicationTargets = collectReplicationTargetsFromPackages(root, cfg);
  const replicationBySystem = new Map(replicationTargets.map((t) => [t.systemId, t]));

  if (!targets.length && !Object.keys(haGroups).length) {
    warn("HA maintain: no HA targets or groups configured — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  log(`HA maintain: ${targets.length} resource(s), ${Object.keys(haGroups).length} group(s)${dryRun ? " [dry-run]" : ""}${prune ? " [prune]" : ""}.`);
  warn("HA maintain: verify cluster fencing is configured before relying on automatic failover.");

  const configPath = join(clumpRoot, "config.json");
  const configRel = "clumps/infrastructure/proxmox/config.json";
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    warn(`HA maintain: no hypervisors in ${configRel}.`);
    return { ok: false, skipped: false, results: [] };
  }

  const lxcStorage = lxcTemplateStorageFromConfig(cfg);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  /** @type {Set<string>} */
  const desiredSids = new Set();

  for (const clusterKey of clusterKeys) {
    const members = byCluster.get(clusterKey);
    if (!members?.length) continue;

    const clusterTargets = targets.filter((t) => hostCluster.get(t.hostId) === clusterKey);
    const clusterGroups = Object.entries(haGroups).filter(([, spec]) =>
      spec.nodes.some((hostId) => hostCluster.get(hostId) === clusterKey),
    );
    if (!clusterTargets.length && !clusterGroups.length) continue;

    const lead = members[0];
    log(
      `Cluster ${JSON.stringify(clusterKey)}: reconcile ${clusterGroups.length} HA group(s), ${clusterTargets.length} resource(s) …`,
    );

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

    const profileResolved = await resolveClusterPveProfile({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      configCluster,
    });
    const useHaRules = (profileResolved?.version.major ?? 9) >= 9;
    if (useHaRules) {
      log(`Cluster ${JSON.stringify(clusterKey)}: PVE ${profileResolved?.version.release ?? "9+"} — HA node-affinity rules API.`);
    }

    /** @type {Record<string, unknown>[]} */
    let resources = [];
    /** @type {Record<string, unknown>[]} */
    let liveResources = [];
    /** @type {Record<string, unknown>[]} */
    let liveGroups = [];
    /** @type {Record<string, unknown>[]} */
    let liveRules = [];
    try {
      resources = await fetchClusterVmResources(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
      );
      liveResources = await fetchPveHaResources(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
      );
      if (useHaRules) {
        liveRules = await fetchPveHaRules(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized);
      } else {
        liveGroups = await fetchPveHaGroups(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized);
      }
    } catch (e) {
      ok = false;
      warn(`Cluster ${JSON.stringify(clusterKey)} API read failed: ${/** @type {Error} */ (e).message || e}`);
      continue;
    }

    const liveResourcesBySid = new Map(
      liveResources
        .filter((r) => typeof r.sid === "string")
        .map((r) => [String(r.sid), r]),
    );
    const liveGroupsById = new Map(
      liveGroups
        .filter((g) => typeof g.group === "string")
        .map((g) => [String(g.group), g]),
    );
    const liveRulesById = new Map(
      liveRules
        .filter((r) => typeof r.rule === "string")
        .map((r) => [String(r.rule), r]),
    );

    /** @type {Map<string, Set<string>>} */
    const sidsByGroup = new Map();

    for (const target of clusterTargets) {
      /** @type {Record<string, unknown>} */
      const row = {
        systemId: target.systemId,
        hostId: target.hostId,
        group: target.ha.group,
        clusterKey,
        kind: "resource",
      };

      if (!target.ha.group) {
        warn(`[${target.systemId}] ha.group missing — skip.`);
        row.ok = false;
        row.action = "skipped";
        row.error = "missing ha.group";
        results.push(row);
        continue;
      }

      if (!replicationBySystem.has(target.systemId)) {
        warn(
          `[${target.systemId}] HA enabled without replication config — failover to replica requires replication.`,
        );
        row.replicationWarning = "no replication config";
      }

      let vmid = target.vmid;
      /** @type {string} */
      let guestType = "qemu";
      if (vmid === null) {
        const located = locateGuestByNameInCluster(resources, target.lookupName);
        if (!located) {
          warn(`[${target.systemId}] guest ${JSON.stringify(target.lookupName)} not found — skip.`);
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
          warn(`[${target.systemId}] vmid ${vmid} not found — skip.`);
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
      row.sid = haResourceSid(guestType, vmid);
      desiredSids.add(String(row.sid));
      let groupSet = sidsByGroup.get(target.ha.group);
      if (!groupSet) {
        groupSet = new Set();
        sidsByGroup.set(target.ha.group, groupSet);
      }
      groupSet.add(String(row.sid));

      const resolvedTarget = { ...target, vmid };
      const desired = buildHaResourceBody(resolvedTarget, target.ha, guestType, { omitGroup: useHaRules });
      const sid = String(desired.sid);
      const live = liveResourcesBySid.get(sid);

      if (live && haResourcesMatch(desired, live)) {
        log(`[${target.systemId}] HA resource ${JSON.stringify(sid)} OK.`);
        row.ok = true;
        row.action = "unchanged";
        results.push(row);
        continue;
      }

      if (live) {
        log(`[${target.systemId}] HA resource ${JSON.stringify(sid)} differs — will update${dryRun ? " [dry-run]" : ""}.`);
        row.action = "update";
      } else {
        log(`[${target.systemId}] HA resource ${JSON.stringify(sid)} missing — will create${dryRun ? " [dry-run]" : ""}.`);
        row.action = "create";
      }

      if (dryRun) {
        row.ok = true;
        results.push(row);
        continue;
      }

      try {
        const form = pveFormBody(desired);
        if (live) {
          await pveJsonRequest(
            "PUT",
            auth.host.apiBase,
            `/cluster/ha/resources/${encodeURIComponent(sid)}`,
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
        } else {
          await pveJsonRequest(
            "POST",
            auth.host.apiBase,
            "/cluster/ha/resources",
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
        }
        log(`[${target.systemId}] HA resource ${JSON.stringify(sid)} ${live ? "updated" : "created"}.`);
        row.ok = true;
      } catch (e) {
        ok = false;
        const err = /** @type {Error} */ (e).message || String(e);
        warn(`[${target.systemId}] HA resource ${JSON.stringify(sid)} failed: ${err}`);
        row.ok = false;
        row.error = err;
      }
      results.push(row);
    }

    for (const [groupId, groupSpec] of clusterGroups) {
      const resourceSids = [...(sidsByGroup.get(groupId) ?? [])];
      /** @type {Record<string, unknown>} */
      const row = { group: groupId, clusterKey, kind: useHaRules ? "rule" : "group" };

      if (useHaRules) {
        const desired = buildHaNodeAffinityRuleBody(groupId, groupSpec, hostToNode, resourceSids);
        const live = liveRulesById.get(groupId);
        if (live && haNodeAffinityRulesMatch(desired, live)) {
          log(`HA rule ${JSON.stringify(groupId)} OK (${resourceSids.length} resource(s)).`);
          row.ok = true;
          row.action = "unchanged";
          results.push(row);
          continue;
        }
        if (live) {
          log(`HA rule ${JSON.stringify(groupId)} differs — will update${dryRun ? " [dry-run]" : ""}.`);
          row.action = "update";
        } else {
          log(`HA rule ${JSON.stringify(groupId)} missing — will create${dryRun ? " [dry-run]" : ""}.`);
          row.action = "create";
        }
        if (dryRun) {
          row.ok = true;
          results.push(row);
          continue;
        }
        try {
          /** @type {Record<string, string | number>} */
          const body = { ...desired };
          if (live && typeof live.digest === "string") {
            body.digest = live.digest;
          }
          const form = pveFormBody(body);
          if (live) {
            await pveJsonRequest(
              "PUT",
              auth.host.apiBase,
              `/cluster/ha/rules/${encodeURIComponent(groupId)}`,
              auth.authorization,
              auth.rejectUnauthorized,
              form,
            );
          } else {
            await pveJsonRequest(
              "POST",
              auth.host.apiBase,
              "/cluster/ha/rules",
              auth.authorization,
              auth.rejectUnauthorized,
              form,
            );
          }
          log(`HA rule ${JSON.stringify(groupId)} ${live ? "updated" : "created"}.`);
          row.ok = true;
        } catch (e) {
          ok = false;
          const err = /** @type {Error} */ (e).message || String(e);
          warn(`HA rule ${JSON.stringify(groupId)} failed: ${err}`);
          row.ok = false;
          row.error = err;
        }
        results.push(row);
        continue;
      }

      const desired = buildHaGroupBody(groupId, groupSpec, hostToNode);
      const live = liveGroupsById.get(groupId);
      if (live && haGroupsMatch(desired, live)) {
        log(`HA group ${JSON.stringify(groupId)} OK.`);
        row.ok = true;
        row.action = "unchanged";
        results.push(row);
        continue;
      }
      if (live) {
        log(`HA group ${JSON.stringify(groupId)} differs — will update${dryRun ? " [dry-run]" : ""}.`);
        row.action = "update";
      } else {
        log(`HA group ${JSON.stringify(groupId)} missing — will create${dryRun ? " [dry-run]" : ""}.`);
        row.action = "create";
      }
      if (dryRun) {
        row.ok = true;
        results.push(row);
        continue;
      }
      try {
        const form = pveFormBody(desired);
        if (live) {
          await pveJsonRequest(
            "PUT",
            auth.host.apiBase,
            `/cluster/ha/groups/${encodeURIComponent(groupId)}`,
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
        } else {
          await pveJsonRequest(
            "POST",
            auth.host.apiBase,
            "/cluster/ha/groups",
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
        }
        log(`HA group ${JSON.stringify(groupId)} ${live ? "updated" : "created"}.`);
        row.ok = true;
      } catch (e) {
        ok = false;
        const err = /** @type {Error} */ (e).message || String(e);
        warn(`HA group ${JSON.stringify(groupId)} failed: ${err}`);
        row.ok = false;
        row.error = err;
      }
      results.push(row);
    }

    if (prune) {
      for (const resource of liveResources) {
        const sid = typeof resource.sid === "string" ? resource.sid.trim() : "";
        const comment = typeof resource.comment === "string" ? resource.comment.trim() : "";
        if (!isHdcManagedHaComment(comment)) continue;
        if (desiredSids.has(sid)) continue;
        log(`HA resource ${JSON.stringify(sid)} stale — will delete${dryRun ? " [dry-run]" : ""}.`);
        /** @type {Record<string, unknown>} */
        const row = { sid, action: "delete", clusterKey, kind: "resource" };
        if (dryRun) {
          row.ok = true;
          results.push(row);
          continue;
        }
        try {
          await pveJsonRequest(
            "DELETE",
            auth.host.apiBase,
            `/cluster/ha/resources/${encodeURIComponent(sid)}`,
            auth.authorization,
            auth.rejectUnauthorized,
            undefined,
          );
          log(`HA resource ${JSON.stringify(sid)} deleted.`);
          row.ok = true;
        } catch (e) {
          ok = false;
          const err = /** @type {Error} */ (e).message || String(e);
          warn(`HA resource ${JSON.stringify(sid)} delete failed: ${err}`);
          row.ok = false;
          row.error = err;
        }
        results.push(row);
      }
    }
  }

  return { ok, skipped: false, results };
}
