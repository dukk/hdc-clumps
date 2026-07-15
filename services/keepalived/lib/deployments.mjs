import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const KEEPALIVED_ROLE = "keepalived";

/** @typedef {"director" | "real_server"} DeploymentKind */
/** @typedef {"MASTER" | "BACKUP"} VrrpState */

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
function deepMerge(target, source) {
  for (const [key, val] of Object.entries(source)) {
    if (isObject(val) && isObject(target[key])) {
      deepMerge(/** @type {Record<string, unknown>} */ (target[key]), val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

/**
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown>} entry
 */
function mergeDeploymentEntry(defaults, entry) {
  const base = structuredClone(defaults);
  deepMerge(base, entry);
  const systemId =
    typeof entry.system_id === "string" && entry.system_id.trim()
      ? entry.system_id.trim()
      : typeof base.system_id === "string" && base.system_id.trim()
        ? base.system_id.trim()
        : "";
  if (systemId) base.system_id = systemId;
  return base;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeKeepalivedConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("keepalived config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("keepalived config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  const keepalived = isObject(cfg.keepalived)
    ? cfg.keepalived
    : isObject(defaults.keepalived)
      ? defaults.keepalived
      : {};
  const vrrpInstances = parseVrrpInstances(cfg, defaults);
  const virtualServers = parseVirtualServers(cfg, defaults, vrrpInstances);
  validateDeployments(deployments, vrrpInstances, virtualServers);
  return {
    schemaVersion: version >= 2 ? 2 : version,
    defaults,
    deployments,
    keepalived,
    vrrpInstances,
    virtualServers,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, unknown>} defaults
 */
export function parseVrrpInstances(cfg, defaults) {
  const raw = Array.isArray(cfg.vrrp_instances)
    ? cfg.vrrp_instances
    : Array.isArray(defaults.vrrp_instances)
      ? defaults.vrrp_instances
      : [];
  /** @type {ReturnType<typeof parseVrrpInstances>} */
  const out = [];
  const ids = new Set();
  const routerIds = new Set();

  for (const entry of raw.filter(isObject)) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) throw new Error("vrrp_instances[] entry needs id");
    if (ids.has(id)) throw new Error(`duplicate vrrp_instances id ${JSON.stringify(id)}`);
    ids.add(id);

    const virtualRouterId =
      typeof entry.virtual_router_id === "number"
        ? entry.virtual_router_id
        : Number(entry.virtual_router_id);
    if (!Number.isFinite(virtualRouterId) || virtualRouterId < 1 || virtualRouterId > 255) {
      throw new Error(`${id}: virtual_router_id must be 1–255`);
    }
    if (routerIds.has(virtualRouterId)) {
      throw new Error(`duplicate virtual_router_id ${virtualRouterId}`);
    }
    routerIds.add(virtualRouterId);

    const iface =
      typeof entry.interface === "string" && entry.interface.trim()
        ? entry.interface.trim()
        : "eth0";
    const virtualIpaddress = Array.isArray(entry.virtual_ipaddress)
      ? entry.virtual_ipaddress.map((a) => String(a).trim()).filter(Boolean)
      : [];
    if (!virtualIpaddress.length) {
      throw new Error(`${id}: virtual_ipaddress needs at least one address`);
    }

    const instanceName =
      typeof entry.instance_name === "string" && entry.instance_name.trim()
        ? entry.instance_name.trim()
        : `VI_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;

    /** @type {{ id: string; script: string; interval: number; weight: number }[]} */
    const trackScripts = [];
    if (Array.isArray(entry.track_scripts)) {
      for (const ts of entry.track_scripts.filter(isObject)) {
        const tsId = typeof ts.id === "string" ? ts.id.trim() : "";
        const script = typeof ts.script === "string" ? ts.script.trim() : "";
        if (!tsId || !script) throw new Error(`${id}: track_scripts entry needs id and script`);
        const interval = typeof ts.interval === "number" ? ts.interval : Number(ts.interval) || 2;
        const weight = typeof ts.weight === "number" ? ts.weight : Number(ts.weight) || 0;
        trackScripts.push({ id: tsId, script, interval, weight });
      }
    }

    out.push({
      id,
      instanceName,
      virtualRouterId,
      interface: iface,
      virtualIpaddress,
      trackScripts,
    });
  }

  if (!out.length) {
    throw new Error("keepalived config needs vrrp_instances[] with at least one entry");
  }
  return out;
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, unknown>} defaults
 * @param {ReturnType<typeof parseVrrpInstances>} vrrpInstances
 */
export function parseVirtualServers(cfg, defaults, vrrpInstances) {
  const raw = Array.isArray(cfg.virtual_servers)
    ? cfg.virtual_servers
    : Array.isArray(defaults.virtual_servers)
      ? defaults.virtual_servers
      : [];
  const vrrpIds = new Set(vrrpInstances.map((v) => v.id));
  /** @type {ReturnType<typeof parseVirtualServers>} */
  const out = [];
  const ids = new Set();

  for (const entry of raw.filter(isObject)) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) throw new Error("virtual_servers[] entry needs id");
    if (ids.has(id)) throw new Error(`duplicate virtual_servers id ${JSON.stringify(id)}`);
    ids.add(id);

    const vrrpInstanceId =
      typeof entry.vrrp_instance_id === "string" ? entry.vrrp_instance_id.trim() : "";
    if (!vrrpInstanceId || !vrrpIds.has(vrrpInstanceId)) {
      throw new Error(`${id}: vrrp_instance_id must reference vrrp_instances[].id`);
    }

    const vip = typeof entry.vip === "string" ? entry.vip.trim() : "";
    const port = typeof entry.port === "number" ? entry.port : Number(entry.port);
    if (!vip || !Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`${id}: vip and port (1–65535) required`);
    }

    const protocol =
      typeof entry.protocol === "string" && entry.protocol.trim()
        ? entry.protocol.trim().toUpperCase()
        : "TCP";
    const lbKind =
      typeof entry.lb_kind === "string" && entry.lb_kind.trim()
        ? entry.lb_kind.trim().toUpperCase()
        : "NAT";
    if (!["NAT", "DR", "TUN"].includes(lbKind)) {
      throw new Error(`${id}: lb_kind must be NAT, DR, or TUN`);
    }
    const lbAlgo =
      typeof entry.lb_algo === "string" && entry.lb_algo.trim() ? entry.lb_algo.trim() : "rr";

    /** @type {{ address: string; port: number; weight: number; systemId: string | null }[]} */
    const realServers = [];
    if (Array.isArray(entry.real_servers)) {
      for (const rs of entry.real_servers.filter(isObject)) {
        const address = typeof rs.address === "string" ? rs.address.trim() : "";
        const rsPort = typeof rs.port === "number" ? rs.port : Number(rs.port);
        const weight = typeof rs.weight === "number" ? rs.weight : Number(rs.weight) || 1;
        const systemId =
          typeof rs.system_id === "string" && rs.system_id.trim() ? rs.system_id.trim() : null;
        if (!address || !Number.isFinite(rsPort)) {
          throw new Error(`${id}: real_servers entry needs address and port`);
        }
        realServers.push({ address, port: rsPort, weight, systemId });
      }
    }
    if (!realServers.length) {
      throw new Error(`${id}: virtual_servers needs at least one real_servers entry`);
    }

    out.push({
      id,
      vrrpInstanceId,
      vip,
      port,
      protocol,
      lbKind,
      lbAlgo,
      realServers,
    });
  }
  return out;
}

/**
 * @param {Record<string, unknown>[]} deployments
 * @param {ReturnType<typeof parseVrrpInstances>} vrrpInstances
 * @param {ReturnType<typeof parseVirtualServers>} virtualServers
 */
function validateDeployments(deployments, vrrpInstances, virtualServers) {
  const ids = new Set();
  /** @type {Record<string, unknown>[]} */
  const directors = [];
  /** @type {Record<string, unknown>[]} */
  const realServers = [];
  const vrrpIds = new Set(vrrpInstances.map((v) => v.id));
  const vsById = new Map(virtualServers.map((vs) => [vs.id, vs]));
  const realServerSystemIds = new Set();

  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const kind =
      typeof d.deployment_kind === "string" ? d.deployment_kind.trim().toLowerCase() : "";
    if (kind !== "director" && kind !== "real_server") {
      throw new Error(`${sid}: deployment_kind must be director or real_server`);
    }

    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
    const configure = isObject(d.configure) ? d.configure : {};
    const ssh = isObject(configure.ssh) ? configure.ssh : {};
    const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
    if (!host) throw new Error(`${sid}: configure.ssh.host required`);

    if (kind === "director") {
      directors.push(d);
      const state = typeof d.state === "string" ? d.state.trim().toUpperCase() : "";
      if (state !== "MASTER" && state !== "BACKUP") {
        throw new Error(`${sid}: director state must be MASTER or BACKUP`);
      }
      const priority = typeof d.priority === "number" ? d.priority : Number(d.priority);
      if (!Number.isFinite(priority) || priority < 1 || priority > 255) {
        throw new Error(`${sid}: director priority must be 1–255`);
      }
      const vrrpInstanceIds = Array.isArray(d.vrrp_instance_ids)
        ? d.vrrp_instance_ids.map((x) => String(x).trim()).filter(Boolean)
        : [];
      if (!vrrpInstanceIds.length) {
        throw new Error(`${sid}: director needs vrrp_instance_ids[]`);
      }
      for (const vid of vrrpInstanceIds) {
        if (!vrrpIds.has(vid)) {
          throw new Error(`${sid}: unknown vrrp_instance_id ${JSON.stringify(vid)}`);
        }
      }
      if (mode === "proxmox-qemu") {
        const px = isObject(d.proxmox) ? d.proxmox : {};
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        if (!hostId) throw new Error(`${sid}: proxmox.host_id required for proxmox-qemu`);
        const q = isObject(px.qemu) ? px.qemu : {};
        const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
        if (!Number.isFinite(vmid) || vmid <= 0) {
          throw new Error(`${sid}: proxmox.qemu.vmid must be a positive number`);
        }
      }
    } else {
      realServers.push(d);
      realServerSystemIds.add(sid);
      if (mode !== "configure-only") {
        throw new Error(`${sid}: real_server deployments must use mode configure-only`);
      }
      const lbKind =
        typeof d.lb_kind === "string" ? d.lb_kind.trim().toUpperCase() : "";
      if (!["NAT", "DR", "TUN"].includes(lbKind)) {
        throw new Error(`${sid}: real_server lb_kind must be NAT, DR, or TUN`);
      }
      const virtualServerIds = Array.isArray(d.virtual_server_ids)
        ? d.virtual_server_ids.map((x) => String(x).trim()).filter(Boolean)
        : [];
      if (!virtualServerIds.length) {
        throw new Error(`${sid}: real_server needs virtual_server_ids[]`);
      }
      for (const vsid of virtualServerIds) {
        const vs = vsById.get(vsid);
        if (!vs) throw new Error(`${sid}: unknown virtual_server_id ${JSON.stringify(vsid)}`);
        if (vs.lbKind !== lbKind) {
          throw new Error(
            `${sid}: lb_kind ${lbKind} does not match virtual_server ${vsid} (${vs.lbKind})`,
          );
        }
      }
    }
  }

  if (directors.length < 2) {
    throw new Error("keepalived needs at least two director deployments");
  }
  const states = new Set(
    directors.map((d) => (typeof d.state === "string" ? d.state.trim().toUpperCase() : "")),
  );
  if (!states.has("MASTER") || !states.has("BACKUP")) {
    throw new Error("director deployments need at least one MASTER and one BACKUP");
  }

  for (const vs of virtualServers) {
    for (const rs of vs.realServers) {
      if (rs.systemId && !realServerSystemIds.has(rs.systemId)) {
        throw new Error(
          `virtual_servers ${vs.id}: real_servers system_id ${JSON.stringify(rs.systemId)} has no matching real_server deployment`,
        );
      }
    }
  }
}

/**
 * @param {ReturnType<typeof normalizeKeepalivedConfig>} normalized
 */
export function keepalivedGlobalSettings(normalized) {
  const kv = isObject(normalized.keepalived) ? normalized.keepalived : {};
  return {
    authPassVaultKey:
      typeof kv.auth_pass_vault_key === "string" && kv.auth_pass_vault_key.trim()
        ? kv.auth_pass_vault_key.trim()
        : "HDC_KEEPALIVED_AUTH_PASS",
    routerId:
      typeof kv.router_id === "string" && kv.router_id.trim() ? kv.router_id.trim() : "HDC_LVS",
  };
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (/^vm-keepalived-[a-z]+$/.test(t)) return t;
  return vmSystemId(KEEPALIVED_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 */
export function finalizeDirectorDeployment(d, skipInstallCli) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli) install.enabled = false;
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-qemu";
  const vrrpInstanceIds = Array.isArray(d.vrrp_instance_ids)
    ? d.vrrp_instance_ids.map((x) => String(x).trim()).filter(Boolean)
    : [];
  return {
    deploymentKind: /** @type {"director"} */ ("director"),
    systemId: String(d.system_id),
    mode,
    role: typeof d.role === "string" ? d.role.trim().toLowerCase() : "",
    state: /** @type {VrrpState} */ (
      typeof d.state === "string" ? d.state.trim().toUpperCase() : "BACKUP"
    ),
    priority: typeof d.priority === "number" ? d.priority : Number(d.priority) || 100,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    vrrpInstanceIds,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    install,
  };
}

/**
 * @param {Record<string, unknown>} d
 */
export function finalizeRealServerDeployment(d) {
  const virtualServerIds = Array.isArray(d.virtual_server_ids)
    ? d.virtual_server_ids.map((x) => String(x).trim()).filter(Boolean)
    : [];
  return {
    deploymentKind: /** @type {"real_server"} */ ("real_server"),
    systemId: String(d.system_id),
    mode: "configure-only",
    lbKind:
      typeof d.lb_kind === "string" ? d.lb_kind.trim().toUpperCase() : "NAT",
    virtualServerIds,
    configure: isObject(d.configure) ? d.configure : null,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveKeepalivedDeployments(cfg, flags) {
  const { deployments } = normalizeKeepalivedConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;
  const directorOnly = flags["director-only"] !== undefined;
  const realServerOnly = flags["real-server-only"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance);
  }

  /** @type {Array<ReturnType<typeof finalizeDirectorDeployment> | ReturnType<typeof finalizeRealServerDeployment>>} */
  let selected = deployments.map((d) => {
    const kind =
      typeof d.deployment_kind === "string" ? d.deployment_kind.trim().toLowerCase() : "";
    if (kind === "real_server") return finalizeRealServerDeployment(d);
    return finalizeDirectorDeployment(d, skipInstallCli);
  });

  if (directorOnly) {
    selected = selected.filter((d) => d.deploymentKind === "director");
  }
  if (realServerOnly) {
    selected = selected.filter((d) => d.deploymentKind === "real_server");
  }

  if (selectedId) {
    const hit = selected.find((d) => d.systemId === selectedId);
    if (!hit) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
    return [hit];
  }

  return selected;
}

/**
 * Order deployments for deploy: MASTER directors, BACKUP directors, real servers.
 * @param {ReturnType<typeof resolveKeepalivedDeployments>} deployments
 */
export function orderDeploymentsForDeploy(deployments) {
  const directors = deployments.filter((d) => d.deploymentKind === "director");
  const realServers = deployments.filter((d) => d.deploymentKind === "real_server");
  const master = directors.filter((d) => d.state === "MASTER");
  const backup = directors.filter((d) => d.state === "BACKUP");
  return [...master, ...backup, ...realServers];
}

/**
 * @param {ReturnType<typeof finalizeDirectorDeployment> | ReturnType<typeof finalizeRealServerDeployment>} deployment
 */
export function sshHostFromDeployment(deployment) {
  const cfg = deployment.configure;
  if (!isObject(cfg) || !isObject(cfg.ssh)) return "";
  return typeof cfg.ssh.host === "string" ? cfg.ssh.host.trim() : "";
}

/**
 * @param {ReturnType<typeof normalizeKeepalivedConfig>} normalized
 */
export function listKeepalivedDeploymentSummaries(normalized) {
  return normalized.deployments.map((d) => {
    const kind =
      typeof d.deployment_kind === "string" ? d.deployment_kind.trim().toLowerCase() : "";
    const mode = typeof d.mode === "string" ? d.mode : "proxmox-qemu";
    return {
      system_id: d.system_id,
      deployment_kind: kind,
      mode,
      role: typeof d.role === "string" ? d.role : null,
      state: typeof d.state === "string" ? d.state : null,
    };
  });
}

/**
 * @param {ReturnType<typeof parseVirtualServers>} virtualServers
 * @param {string[]} virtualServerIds
 */
export function virtualServersForRealServer(virtualServers, virtualServerIds) {
  const ids = new Set(virtualServerIds);
  return virtualServers.filter((vs) => ids.has(vs.id));
}

/**
 * @param {ReturnType<typeof parseVrrpInstances>} vrrpInstances
 * @param {ReturnType<typeof parseVirtualServers>} virtualServers
 */
export function directorVipAddresses(vrrpInstances, virtualServers) {
  const fromVrrp = vrrpInstances.flatMap((v) => v.virtualIpaddress);
  const fromVs = virtualServers.map((vs) => vs.vip);
  return [...new Set([...fromVrrp, ...fromVs])];
}

/**
 * @param {ReturnType<typeof parseVirtualServers>} virtualServers
 */
export function usesNatLbKind(virtualServers) {
  return virtualServers.some((vs) => vs.lbKind === "NAT");
}
