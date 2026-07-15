import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const CASSANDRA_ROLE = "cassandra";
const SYSTEM_ID_PATTERN = /^vm-cassandra-[a-z]+$/;
const REQUIRED_NODE_COUNT = 3;

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
export function normalizeCassandraConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("cassandra config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("cassandra config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const cassandra = isObject(cfg.cassandra) ? cfg.cassandra : isObject(defaults.cassandra) ? defaults.cassandra : {};
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments, cassandra };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  if (deployments.length !== REQUIRED_NODE_COUNT) {
    throw new Error(`cassandra config requires exactly ${REQUIRED_NODE_COUNT} deployments (found ${deployments.length})`);
  }
  const ids = new Set();
  const vmids = new Set();
  const ips = new Set();
  let seedCount = 0;
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!SYSTEM_ID_PATTERN.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-cassandra-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    if (d.seed === true) seedCount += 1;
    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
    if (mode === "proxmox-qemu" || mode === "") {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
      if (!hostId) throw new Error(`${sid}: proxmox.host_id required for proxmox-qemu`);
      const q = isObject(px.qemu) ? px.qemu : {};
      const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
      if (!Number.isFinite(vmid) || vmid <= 0) {
        throw new Error(`${sid}: proxmox.qemu.vmid must be a positive number`);
      }
      if (vmids.has(vmid)) throw new Error(`duplicate vmid ${vmid}`);
      vmids.add(vmid);
      const ip = typeof q.ip === "string" ? q.ip.trim().split("/")[0] : "";
      if (ip) {
        if (ips.has(ip)) throw new Error(`duplicate node IP ${ip}`);
        ips.add(ip);
      }
    }
  }
  if (seedCount < 1) {
    throw new Error("deployments must include at least one seed: true");
  }
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (SYSTEM_ID_PATTERN.test(t)) return t;
  return vmSystemId(CASSANDRA_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 */
function deploymentListenIp(d) {
  const cfg = isObject(d.configure) ? d.configure : {};
  const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
  const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
  if (host) return host;
  const px = isObject(d.proxmox) ? d.proxmox : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const ip = typeof q.ip === "string" ? q.ip.trim().split("/")[0] : "";
  return ip;
}

/**
 * @param {Record<string, unknown>[]} deployments
 * @param {string[]} [explicitSeeds]
 */
export function deriveSeedIps(deployments, explicitSeeds) {
  if (Array.isArray(explicitSeeds) && explicitSeeds.length > 0) {
    return explicitSeeds.map((s) => String(s).trim()).filter(Boolean);
  }
  return deployments
    .filter((d) => d.seed === true)
    .map((d) => deploymentListenIp(d))
    .filter(Boolean);
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
export function bootstrapSortDeployments(deployments) {
  return [...deployments].sort((a, b) => {
    const sa = a.seed === true ? 0 : 1;
    const sb = b.seed === true ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const idA = String(a.system_id ?? "");
    const idB = String(b.system_id ?? "");
    return idA.localeCompare(idB);
  });
}

/**
 * @param {Record<string, unknown>} d
 */
function finalizeDeployment(d) {
  const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
  return {
    systemId: String(d.system_id),
    mode,
    seed: d.seed === true,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    listenIp: deploymentListenIp(d),
    rack: typeof d.rack === "string" && d.rack.trim() ? d.rack.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    memoryMb: deploymentMemoryMb(d),
  };
}

/**
 * @param {Record<string, unknown>} d
 */
function deploymentMemoryMb(d) {
  const px = isObject(d.proxmox) ? d.proxmox : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const mem = typeof q.memory_mb === "number" ? q.memory_mb : Number(q.memory_mb);
  if (Number.isFinite(mem) && mem > 0) return mem;
  return 8192;
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveCassandraDeployments(cfg, flags) {
  const { deployments } = normalizeCassandraConfig(cfg);
  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance);
  }

  if (deployments.length === 1) {
    const d = deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [finalizeDeployment(d)];
  }

  if (!selectedId) {
    const sorted = bootstrapSortDeployments(deployments);
    return sorted.map((d) => finalizeDeployment(d));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [finalizeDeployment(d)];
}

/**
 * @param {ReturnType<typeof normalizeCassandraConfig>} normalized
 * @param {ReturnType<typeof resolveCassandraDeployments>} resolvedDeployments
 */
export function cassandraGlobalSettings(normalized, resolvedDeployments) {
  const c = isObject(normalized.cassandra) ? normalized.cassandra : {};
  const defaults = isObject(normalized.defaults) ? normalized.defaults : {};
  const pxDefaults = isObject(defaults.proxmox) ? defaults.proxmox : {};
  const qDefaults = isObject(pxDefaults.qemu) ? pxDefaults.qemu : {};
  const defaultMem =
    typeof qDefaults.memory_mb === "number" ? qDefaults.memory_mb : Number(qDefaults.memory_mb);
  const explicitSeeds = Array.isArray(c.seeds)
    ? c.seeds.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const seedIps = deriveSeedIps(normalized.deployments, explicitSeeds);
  const auth =
    typeof c.authenticator === "string" && c.authenticator.trim()
      ? c.authenticator.trim()
      : "PasswordAuthenticator";
  return {
    clusterName:
      typeof c.cluster_name === "string" && c.cluster_name.trim()
        ? c.cluster_name.trim()
        : "hdc-cassandra",
    version: typeof c.version === "string" && c.version.trim() ? c.version.trim() : "5.0",
    datacenter: typeof c.datacenter === "string" && c.datacenter.trim() ? c.datacenter.trim() : "dc1",
    rack: typeof c.rack === "string" && c.rack.trim() ? c.rack.trim() : "rack1",
    replicationFactor:
      typeof c.replication_factor === "number" && c.replication_factor > 0
        ? c.replication_factor
        : 3,
    seedIps,
    authenticator: auth,
    passwordAuthEnabled: auth === "PasswordAuthenticator",
    superuserVaultKey:
      typeof c.superuser_vault_key === "string" && c.superuser_vault_key.trim()
        ? c.superuser_vault_key.trim()
        : "HDC_CASSANDRA_SUPERUSER_PASSWORD",
    defaultMemoryMb: Number.isFinite(defaultMem) && defaultMem > 0 ? defaultMem : 8192,
    nodeIps: resolvedDeployments.map((d) => d.listenIp).filter(Boolean),
  };
}

/**
 * @param {string} version
 */
export function cassandraAptSuite(version) {
  const v = version.trim();
  if (v.startsWith("5")) return "50x";
  if (v.startsWith("4.1")) return "41x";
  if (v.startsWith("4.0")) return "40x";
  if (v.startsWith("4")) return "41x";
  return "50x";
}
