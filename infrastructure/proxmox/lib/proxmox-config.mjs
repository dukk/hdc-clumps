/**
 * Parse `clumps/infrastructure/proxmox/config.json` (see apps/hdc-cli/schema/proxmox.config.schema.json).
 */

/**
 * @param {unknown} row
 * @returns {row is Record<string, unknown>}
 */
export function isProxmoxConfigObject(row) {
  return row !== null && typeof row === "object" && !Array.isArray(row);
}

/**
 * @param {string} webUiOrBase
 */
/**
 * Split a Proxmox volume id (`local:vztmpl/name.tar.zst`) into storage id and full volid.
 * @param {string} volid
 */
export function parseStorageVolid(volid) {
  const s = String(volid ?? "").trim();
  const idx = s.indexOf(":");
  if (idx < 1) return null;
  return { storage: s.slice(0, idx), volid: s };
}

export function apiBaseFromWebUi(webUiOrBase) {
  const s = webUiOrBase.trim();
  const withProto = /:\/\//.test(s) ? s : `https://${s}`;
  const u = new URL(withProto);
  const port = u.port || (u.protocol === "https:" ? "8006" : "80");
  return `${u.protocol}//${u.hostname}:${port}`;
}

/**
 * Resolve API base URL from a host row (and optional parent cluster for legacy configs).
 * @param {Record<string, unknown>} host
 * @param {Record<string, unknown> | null} [cluster]
 * @returns {string | null}
 */
export function apiBaseFromHostRecord(host, cluster = null) {
  const webUi = typeof host.web_ui === "string" ? host.web_ui.trim() : "";
  if (webUi) return apiBaseFromWebUi(webUi);
  const hostApi = typeof host.api_base === "string" ? host.api_base.trim() : "";
  if (hostApi) return apiBaseFromWebUi(hostApi);
  if (cluster) {
    const clusterApi = typeof cluster.api_base === "string" ? cluster.api_base.trim() : "";
    if (clusterApi) return apiBaseFromWebUi(clusterApi);
  }
  return null;
}

/**
 * @param {Record<string, unknown>} host
 * @param {Record<string, unknown>} cluster
 */
export function clusterIdForHost(host, cluster) {
  const hpc = host.proxmox_cluster;
  if (isProxmoxConfigObject(hpc) && typeof hpc.id === "string" && hpc.id.trim()) {
    return hpc.id.trim();
  }
  return typeof cluster.id === "string" && cluster.id.trim() ? cluster.id.trim() : null;
}

/**
 * @param {string} clusterId
 * @param {string} [role]
 */
export function proxmoxClusterRef(clusterId, role = "node") {
  return { id: clusterId, role };
}

/**
 * @param {Record<string, unknown>} host
 * @param {string | null} clusterId
 */
export function proxmoxClusterRefFromHost(host, clusterId) {
  const hpc = host.proxmox_cluster;
  if (isProxmoxConfigObject(hpc) && typeof hpc.id === "string" && hpc.id.trim()) {
    const role = typeof hpc.role === "string" && hpc.role.trim() ? hpc.role.trim() : "node";
    return { id: hpc.id.trim(), role };
  }
  if (clusterId) return proxmoxClusterRef(clusterId, "node");
  return null;
}

/**
 * @param {Record<string, unknown>} host
 * @returns {boolean}
 */
export function isProxmoxHostDown(host) {
  return host.down === true || host.down === 1;
}

/**
 * @typedef {object} ProxmoxConfigHost
 * @property {string} id
 * @property {string} pveNode
 * @property {string} apiBase
 * @property {string | null} clusterId
 * @property {string} [ip]
 * @property {string} [webUi]
 * @property {string} [ssh]
 * @property {Record<string, unknown>} host Raw host object from config
 */

/**
 * @param {Record<string, unknown>} h
 * @param {Record<string, unknown>} cl
 * @returns {ProxmoxConfigHost | null}
 */
function proxmoxConfigHostFromRecord(h, cl) {
  const id = typeof h.id === "string" ? h.id.trim() : "";
  if (!id) return null;
  const apiBase = apiBaseFromHostRecord(h, cl);
  if (!apiBase) return null;
  const pveNode = typeof h.pve_node === "string" && h.pve_node.trim() ? h.pve_node.trim() : id;
  const clusterId = clusterIdForHost(h, cl);
  return {
    id,
    pveNode,
    apiBase,
    clusterId,
    ip: typeof h.ip === "string" ? h.ip.trim() : undefined,
    webUi: typeof h.web_ui === "string" ? h.web_ui.trim() : undefined,
    ssh: typeof h.ssh === "string" ? h.ssh.trim() : undefined,
    host: h,
  };
}

/**
 * Resolve a host by id including hosts marked `down` (for error messages).
 * @param {unknown} cfg
 * @param {string} hostId
 * @returns {ProxmoxConfigHost | null}
 */
export function findProxmoxHostInConfig(cfg, hostId) {
  if (!isProxmoxConfigObject(cfg) || !hostId.trim()) return null;
  const want = hostId.trim();
  const clusters = Array.isArray(cfg.clusters) ? cfg.clusters : [];
  for (const cl of clusters) {
    if (!isProxmoxConfigObject(cl)) continue;
    const hosts = Array.isArray(cl.hosts) ? cl.hosts : [];
    for (const h of hosts) {
      if (!isProxmoxConfigObject(h)) continue;
      const id = typeof h.id === "string" ? h.id.trim() : "";
      if (id !== want) continue;
      return proxmoxConfigHostFromRecord(h, cl);
    }
  }
  return null;
}

/**
 * @param {unknown} cfg
 * @param {string} hostId
 * @returns {ProxmoxConfigHost | null}
 */
export function resolveProxmoxHost(cfg, hostId) {
  const found = findProxmoxHostInConfig(cfg, hostId);
  if (!found || isProxmoxHostDown(found.host)) return null;
  return found;
}

/**
 * @typedef {object} ProxmoxClusterMember
 * @property {string} id
 * @property {string} path
 * @property {string} rel
 * @property {string} apiBase
 * @property {string} pveNode
 * @property {string | null} clusterId
 * @property {Record<string, unknown>} host
 */

/**
 * @param {unknown} cfg
 * @param {{ configPath: string; configRel: string; onSkip?: (id: string, reason: string) => void }} opts
 * @returns {Map<string, ProxmoxClusterMember[]>}
 */
export function loadProxmoxHostsByCluster(cfg, opts) {
  /** @type {Map<string, ProxmoxClusterMember[]>} */
  const byCluster = new Map();
  if (!isProxmoxConfigObject(cfg)) return byCluster;
  const clusters = Array.isArray(cfg.clusters) ? cfg.clusters : [];
  const { configPath, configRel, onSkip } = opts;

  for (const cl of clusters) {
    if (!isProxmoxConfigObject(cl)) continue;
    const clusterId = typeof cl.id === "string" && cl.id.trim() ? cl.id.trim() : null;
    const hosts = Array.isArray(cl.hosts) ? cl.hosts : [];
    for (const h of hosts) {
      if (!isProxmoxConfigObject(h)) continue;
      const id = typeof h.id === "string" ? h.id.trim() : "";
      if (!id) continue;
      if (isProxmoxHostDown(h)) {
        onSkip?.(id, "marked down in config");
        continue;
      }
      const apiBase = apiBaseFromHostRecord(h, cl);
      if (!apiBase) {
        onSkip?.(id, "missing web_ui (or legacy api_base) on host or cluster");
        continue;
      }
      const pveNode = typeof h.pve_node === "string" && h.pve_node.trim() ? h.pve_node.trim() : id;
      const hostClusterId = clusterIdForHost(h, cl) ?? clusterId;
      const key = hostClusterId ?? `__orphan__:${id}`;
      const member = {
        id,
        path: configPath,
        rel: configRel,
        apiBase,
        pveNode,
        clusterId: hostClusterId,
        host: h,
      };
      const arr = byCluster.get(key) ?? [];
      arr.push(member);
      byCluster.set(key, arr);
    }
  }
  for (const [, members] of byCluster) {
    members.sort((a, b) => a.id.localeCompare(b.id));
  }
  return byCluster;
}

/**
 * @param {unknown} cfg
 * @param {string} clusterKey
 * @returns {Record<string, unknown> | null}
 */
export function clusterConfigByKey(cfg, clusterKey) {
  if (!isProxmoxConfigObject(cfg)) return null;
  const clusters = cfg.clusters;
  if (!Array.isArray(clusters)) return null;
  for (const cl of clusters) {
    if (!isProxmoxConfigObject(cl)) continue;
    const id = typeof cl.id === "string" ? cl.id.trim() : "";
    if (id === clusterKey) return cl;
  }
  return null;
}
