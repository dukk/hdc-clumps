import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadProxmoxHostsByCluster, isProxmoxConfigObject } from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "./proxmox-deploy-auth.mjs";
import { fetchClusterVmResources } from "./proxmox-host-provisioner.mjs";
import { fetchPveStorageList } from "./proxmox-storage-maintain.mjs";
import { pveData, pveJsonRequest } from "./pve-http.mjs";

export const WARN_PCT = 85;
export const CRIT_PCT = 95;

/**
 * @param {unknown} row
 * @returns {row is Record<string, unknown>}
 */
function isObject(row) {
  return isProxmoxConfigObject(row);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
export function isGuestResource(row) {
  const typ = typeof row.type === "string" ? row.type.trim() : "";
  if (typ !== "qemu" && typ !== "lxc") return false;
  if (row.template === 1 || row.template === true) return false;
  return true;
}

/**
 * @typedef {object} GuestConfig
 * @property {number} vmid
 * @property {string} name
 * @property {string} type
 * @property {string} node
 * @property {number} maxcpu
 * @property {number} maxmem
 * @property {number} maxdisk
 */

/**
 * @param {Record<string, unknown>} row
 * @returns {GuestConfig | null}
 */
export function guestConfigFromResource(row) {
  if (!isGuestResource(row)) return null;
  const node = typeof row.node === "string" ? row.node.trim() : "";
  if (!node) return null;
  const vmid = asNumber(row.vmid);
  const name =
    (typeof row.name === "string" && row.name.trim()) || (vmid ? `id-${vmid}` : "unknown");
  const typ = typeof row.type === "string" ? row.type.trim() : "qemu";
  return {
    vmid,
    name,
    type: typ,
    node,
    maxcpu: asNumber(row.maxcpu),
    maxmem: asNumber(row.maxmem),
    maxdisk: asNumber(row.maxdisk),
  };
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = asNumber(bytes);
  if (n <= 0) return "0 B";
  const gib = n / 1024 ** 3;
  if (gib >= 0.1) return `${gib.toFixed(1)} GiB`;
  const mib = n / 1024 ** 2;
  if (mib >= 0.1) return `${mib.toFixed(1)} MiB`;
  return `${Math.round(n)} B`;
}

/**
 * @param {number} used
 * @param {number} total
 * @returns {number | null}
 */
export function usagePercent(used, total) {
  const t = asNumber(total);
  const u = asNumber(used);
  if (t <= 0) return null;
  return Math.round((u / t) * 100);
}

/**
 * @param {number | null} usedPercent
 * @returns {string}
 */
export function headroomLabel(usedPercent) {
  if (usedPercent === null) return "unknown";
  if (usedPercent >= CRIT_PCT) return "critical — almost full";
  if (usedPercent >= WARN_PCT) return "low — plan cleanup or pool expansion";
  return "headroom available";
}

/**
 * @param {number} allocated
 * @param {number} capacity
 * @returns {number | null}
 */
export function computeLoadPercent(allocated, capacity) {
  return usagePercent(allocated, capacity);
}

/**
 * @param {unknown} nodes
 * @returns {string[]}
 */
function storageNodeList(nodes) {
  const s = String(nodes ?? "").trim();
  if (!s) return [];
  return s
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * @typedef {object} StorageUsageRow
 * @property {string} id
 * @property {string} type
 * @property {number} total
 * @property {number} used
 * @property {number} avail
 * @property {number | null} usedPercent
 * @property {string} headroom
 */

/**
 * @param {Record<string, unknown>[]} storageRows
 * @param {string} pveNode
 * @returns {StorageUsageRow[]}
 */
export function storagePoolsForNode(storageRows, pveNode) {
  const want = pveNode.trim();
  if (!want) return [];
  /** @type {StorageUsageRow[]} */
  const pools = [];
  for (const row of storageRows) {
    if (!isObject(row)) continue;
    const nodes = storageNodeList(row.nodes);
    if (!nodes.includes(want)) continue;
    if (row.enabled === 0 || row.enabled === false) continue;
    const id = typeof row.storage === "string" ? row.storage.trim() : "";
    if (!id) continue;
    const total = asNumber(row.total);
    const used = asNumber(row.used);
    const avail = asNumber(row.avail);
    const usedPercent = usagePercent(used, total);
    pools.push({
      id,
      type: typeof row.type === "string" ? row.type.trim() : "",
      total,
      used,
      avail,
      usedPercent,
      headroom: headroomLabel(usedPercent),
    });
  }
  pools.sort((a, b) => a.id.localeCompare(b.id));
  return pools;
}

/**
 * @param {Record<string, unknown>[]} storageRows
 * @param {string} pveNode
 * @returns {number}
 */
export function nodeStorageCapacityBytes(storageRows, pveNode) {
  const pools = storagePoolsForNode(storageRows, pveNode);
  let sum = 0;
  for (const p of pools) {
    if (p.total > 0) sum += p.total;
  }
  return sum;
}

/**
 * @typedef {object} RootfsUsage
 * @property {number} total
 * @property {number} used
 * @property {number} avail
 * @property {number | null} usedPercent
 * @property {string} headroom
 */

/**
 * @param {unknown} statusBody
 * @returns {RootfsUsage | null}
 */
export function rootfsFromNodeStatus(statusBody) {
  const raw = pveData(statusBody);
  const status = isObject(raw) ? raw : isObject(statusBody) ? statusBody : null;
  if (!status) return null;
  const rootfs = status.rootfs;
  if (!isObject(rootfs)) return null;
  const total = asNumber(rootfs.total);
  const used = asNumber(rootfs.used);
  const avail = asNumber(rootfs.avail);
  const usedPercent = usagePercent(used, total);
  return {
    total,
    used,
    avail,
    usedPercent,
    headroom: headroomLabel(usedPercent),
  };
}

/**
 * @typedef {object} NodeCapacity
 * @property {number} cpuCount
 * @property {number} memoryBytes
 */

/**
 * @param {unknown} statusBody
 * @returns {NodeCapacity}
 */
export function nodeCapacityFromStatus(statusBody) {
  const raw = pveData(statusBody);
  const status = isObject(raw) ? raw : isObject(statusBody) ? statusBody : null;
  if (!status) return { cpuCount: 0, memoryBytes: 0 };

  let cpuCount = 0;
  const cpuinfo = status.cpuinfo;
  if (isObject(cpuinfo)) {
    cpuCount = asNumber(cpuinfo.cpus);
    if (cpuCount <= 0) {
      const cores = asNumber(cpuinfo.cores);
      const sockets = asNumber(cpuinfo.sockets) || 1;
      cpuCount = cores > 0 ? cores * sockets : 0;
    }
  }

  let memoryBytes = 0;
  const memory = status.memory;
  if (isObject(memory)) {
    memoryBytes = asNumber(memory.total);
  }

  return { cpuCount, memoryBytes };
}

/**
 * @param {GuestConfig[]} guests
 * @returns {Map<string, GuestConfig[]>}
 */
export function aggregateGuestsByNode(guests) {
  /** @type {Map<string, GuestConfig[]>} */
  const byNode = new Map();
  for (const g of guests) {
    const arr = byNode.get(g.node) ?? [];
    arr.push(g);
    byNode.set(g.node, arr);
  }
  for (const [, arr] of byNode) {
    arr.sort((a, b) => a.vmid - b.vmid || a.name.localeCompare(b.name));
  }
  return byNode;
}

/**
 * @param {GuestConfig[]} guests
 * @returns {{ maxcpu: number; maxmem: number; maxdisk: number }}
 */
export function sumGuestResources(guests) {
  let maxcpu = 0;
  let maxmem = 0;
  let maxdisk = 0;
  for (const g of guests) {
    maxcpu += g.maxcpu;
    maxmem += g.maxmem;
    maxdisk += g.maxdisk;
  }
  return { maxcpu, maxmem, maxdisk };
}

/**
 * @param {GuestConfig} g
 * @returns {string}
 */
export function formatGuestLine(g) {
  const cpu = g.maxcpu > 0 ? `${g.maxcpu} vCPU` : "0 vCPU";
  return `  vmid ${g.vmid} ${g.name} (${g.type}): ${cpu}, ${formatBytes(g.maxmem)} RAM, ${formatBytes(g.maxdisk)} disk`;
}

/**
 * @param {object} opts
 * @param {{ maxcpu: number; maxmem: number; maxdisk: number }} opts.totals
 * @param {NodeCapacity} opts.capacity
 * @param {number} opts.storageCapacityBytes
 * @returns {string}
 */
export function formatHostLoadSummary(opts) {
  const { totals, capacity, storageCapacityBytes } = opts;
  const cpuPct = computeLoadPercent(totals.maxcpu, capacity.cpuCount);
  const memPct = computeLoadPercent(totals.maxmem, capacity.memoryBytes);
  const diskPct = computeLoadPercent(totals.maxdisk, storageCapacityBytes);

  const cpuPart =
    cpuPct === null
      ? `CPU ${totals.maxcpu} vCPU (host CPU count unknown)`
      : `CPU ${totals.maxcpu}/${capacity.cpuCount} (${cpuPct}%)`;

  const memPart =
    memPct === null
      ? `RAM ${formatBytes(totals.maxmem)} (host RAM unknown)`
      : `RAM ${formatBytes(totals.maxmem)}/${formatBytes(capacity.memoryBytes)} (${memPct}%)`;

  let diskPart;
  if (storageCapacityBytes > 0 && diskPct !== null) {
    diskPart = `disk ${formatBytes(totals.maxdisk)}/${formatBytes(storageCapacityBytes)} (${diskPct}%)`;
  } else {
    diskPart = `disk ${formatBytes(totals.maxdisk)} (sum of guest maxdisk; no per-node storage total for %)`;
  }

  return `  Configured load: ${cpuPart}, ${memPart}, ${diskPart}`;
}

/**
 * @typedef {object} HostCapacityReport
 * @property {string} id
 * @property {string} pveNode
 * @property {string | null} clusterId
 * @property {GuestConfig[]} guests
 * @property {{ maxcpu: number; maxmem: number; maxdisk: number }} totals
 * @property {NodeCapacity} capacity
 * @property {{ cpu: number | null; mem: number | null; disk: number | null }} loadPercent
 * @property {RootfsUsage | null} rootfs
 * @property {StorageUsageRow[]} storagePools
 * @property {number} storageCapacityBytes
 */

/**
 * @typedef {object} ClusterCapacityReport
 * @property {string} id
 * @property {HostCapacityReport[]} hosts
 */

/**
 * @typedef {object} CapacityReportData
 * @property {boolean} ok
 * @property {string[]} warnings
 * @property {ClusterCapacityReport[]} clusters
 */

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} [opts.warn]
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 * @returns {Promise<CapacityReportData>}
 */
export async function collectProxmoxCapacityReport(opts) {
  const { clumpRoot, warn = () => {}, vault } = opts;
  const configPath = join(clumpRoot, "config.json");
  const configRel = "clumps/infrastructure/proxmox/config.json";

  /** @type {string[]} */
  const warnings = [];
  const warnPush = (line) => {
    warnings.push(line);
    warn(line);
  };

  if (!existsSync(configPath)) {
    warnPush(`Capacity report: missing ${configRel}.`);
    return { ok: false, warnings, clusters: [] };
  }

  /** @type {unknown} */
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    warnPush(`Capacity report: invalid ${configRel}: ${/** @type {Error} */ (e).message}`);
    return { ok: false, warnings, clusters: [] };
  }

  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warnPush(`Capacity report: skip host ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    warnPush(`Capacity report: no hypervisors in ${configRel}.`);
    return { ok: false, warnings, clusters: [] };
  }

  /** @type {ClusterCapacityReport[]} */
  const clusters = [];
  let ok = true;
  let reportedAny = false;

  for (const clusterKey of clusterKeys) {
    const members = byCluster.get(clusterKey);
    if (!members?.length) continue;

    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn: warnPush,
      verifyPaths: PROXMOX_MAINTAIN_VERIFY_PATHS,
    });
    if (!auth) {
      ok = false;
      warnPush(`Capacity report: skipping cluster ${JSON.stringify(clusterKey)} — no API auth.`);
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    let resourceRows = [];
    try {
      resourceRows = await fetchClusterVmResources(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
      );
    } catch (e) {
      ok = false;
      warnPush(
        `Capacity report: cluster ${JSON.stringify(clusterKey)} VM list failed: ${/** @type {Error} */ (e).message || e}`,
      );
      continue;
    }

    /** @type {GuestConfig[]} */
    const guests = [];
    for (const row of resourceRows) {
      if (!isObject(row)) continue;
      const g = guestConfigFromResource(row);
      if (g) guests.push(g);
    }
    const byNode = aggregateGuestsByNode(guests);

    /** @type {Record<string, unknown>[]} */
    let storageRows = [];
    try {
      storageRows = await fetchPveStorageList(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
      );
    } catch (e) {
      warnPush(
        `Capacity report: cluster ${JSON.stringify(clusterKey)} storage list failed: ${/** @type {Error} */ (e).message || e}`,
      );
    }

    /** @type {HostCapacityReport[]} */
    const hosts = [];

    for (const m of members) {
      reportedAny = true;
      const nodeGuests = byNode.get(m.pveNode) ?? [];
      const totals = sumGuestResources(nodeGuests);
      let capacity = { cpuCount: 0, memoryBytes: 0 };
      /** @type {RootfsUsage | null} */
      let rootfs = null;

      try {
        const statusBody = await pveJsonRequest(
          "GET",
          auth.host.apiBase,
          `/nodes/${encodeURIComponent(m.pveNode)}/status`,
          auth.authorization,
          auth.rejectUnauthorized,
          undefined,
        );
        capacity = nodeCapacityFromStatus(statusBody);
        rootfs = rootfsFromNodeStatus(statusBody);
      } catch (e) {
        warnPush(
          `Capacity report: node status for ${JSON.stringify(m.pveNode)} failed: ${/** @type {Error} */ (e).message || e}`,
        );
      }

      const storagePools = storagePoolsForNode(storageRows, m.pveNode);
      const storageCapacityBytes = storagePools.reduce((s, p) => s + (p.total > 0 ? p.total : 0), 0);

      hosts.push({
        id: m.id,
        pveNode: m.pveNode,
        clusterId: m.clusterId,
        guests: nodeGuests,
        totals,
        capacity,
        loadPercent: {
          cpu: computeLoadPercent(totals.maxcpu, capacity.cpuCount),
          mem: computeLoadPercent(totals.maxmem, capacity.memoryBytes),
          disk: computeLoadPercent(totals.maxdisk, storageCapacityBytes),
        },
        rootfs,
        storagePools,
        storageCapacityBytes,
      });
    }

    clusters.push({ id: clusterKey, hosts });
  }

  if (!reportedAny) ok = false;

  return { ok, warnings, clusters };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} [opts.warn]
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 * @returns {Promise<{ ok: boolean; data?: CapacityReportData }>}
 */
export async function runProxmoxHostLoadReport(opts) {
  const { clumpRoot, log, warn = log, vault } = opts;
  const configRel = "clumps/infrastructure/proxmox/config.json";

  if (!existsSync(join(clumpRoot, "config.json"))) {
    warn(`Load report: missing ${configRel} — skip.`);
    return { ok: true };
  }

  log("Configured load report (allocated guest limits vs node capacity) …");

  const data = await collectProxmoxCapacityReport({ clumpRoot, warn, vault });

  for (const cluster of data.clusters) {
    for (const host of cluster.hosts) {
      log(`Host ${JSON.stringify(host.id)} (${JSON.stringify(cluster.id)}) — ${host.guests.length} guest(s)`);
      for (const g of host.guests) {
        log(formatGuestLine(g));
      }
      log(
        formatHostLoadSummary({
          totals: host.totals,
          capacity: host.capacity,
          storageCapacityBytes: host.storageCapacityBytes,
        }),
      );
    }
  }

  if (data.ok) log("Configured load report finished.");
  else log("Configured load report finished with gaps — see warnings.");

  return { ok: data.ok, data };
}
