import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const KAFKA_ROLE = "kafka";
const REQUIRED_BROKERS = 3;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
export function normalizeKafkaConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("kafka config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("kafka config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const kafka = isObject(cfg.kafka) ? cfg.kafka : isObject(defaults.kafka) ? defaults.kafka : {};
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments, kafka };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  if (deployments.length !== REQUIRED_BROKERS) {
    throw new Error(`kafka config requires exactly ${REQUIRED_BROKERS} deployments (found ${deployments.length})`);
  }
  const ids = new Set();
  const nodeIds = new Set();
  const vmids = new Set();
  const hosts = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!/^vm-kafka-[a-z]+$/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-kafka-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const nodeId = typeof d.node_id === "number" ? d.node_id : Number(d.node_id);
    if (!Number.isFinite(nodeId) || nodeId < 1 || nodeId > REQUIRED_BROKERS) {
      throw new Error(`${sid}: node_id must be 1..${REQUIRED_BROKERS}`);
    }
    if (nodeIds.has(nodeId)) throw new Error(`duplicate node_id ${nodeId}`);
    nodeIds.add(nodeId);

    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
    if (mode === "proxmox-qemu" || mode === "configure-only") {
      if (mode === "proxmox-qemu") {
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
      }
    }

    const sshHost = sshHostFromDeployment(d);
    if (!sshHost) throw new Error(`${sid}: configure.ssh.host required`);
    if (hosts.has(sshHost)) throw new Error(`duplicate configure.ssh.host ${sshHost}`);
    hosts.add(sshHost);
  }
  for (let i = 1; i <= REQUIRED_BROKERS; i += 1) {
    if (!nodeIds.has(i)) {
      throw new Error(`deployments must include node_id ${i}`);
    }
  }
}

/**
 * @param {Record<string, unknown>} d
 */
export function sshHostFromDeployment(d) {
  const cfg = isObject(d.configure) ? d.configure : {};
  const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
  const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
  if (host) return host;
  const px = isObject(d.proxmox) ? d.proxmox : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  return ip ? ip.split("/")[0] : "";
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function kafkaGlobalSettings(normalized) {
  const k = isObject(normalized.kafka) ? normalized.kafka : {};
  const clusterId = typeof k.cluster_id === "string" ? k.cluster_id.trim() : "";
  if (!clusterId || clusterId.includes("REPLACE_WITH")) {
    throw new Error("kafka.cluster_id required (generate with kafka-storage.sh random-uuid)");
  }
  if (!UUID_RE.test(clusterId)) {
    throw new Error("kafka.cluster_id must be a UUID");
  }
  const logDirs = Array.isArray(k.log_dirs)
    ? k.log_dirs.map((x) => String(x).trim()).filter(Boolean)
    : ["/var/lib/kafka/data"];
  return {
    clusterId,
    version: typeof k.version === "string" && k.version.trim() ? k.version.trim() : "3.9.0",
    scalaVersion:
      typeof k.scala_version === "string" && k.scala_version.trim() ? k.scala_version.trim() : "2.13",
    listenerPort: typeof k.listener_port === "number" ? k.listener_port : Number(k.listener_port) || 9092,
    controllerPort:
      typeof k.controller_port === "number" ? k.controller_port : Number(k.controller_port) || 9093,
    logDirs,
  };
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (/^vm-kafka-[a-z]+$/.test(t)) return t;
  return vmSystemId(KAFKA_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 */
export function finalizeDeployment(d) {
  const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
  const nodeId = typeof d.node_id === "number" ? d.node_id : Number(d.node_id);
  return {
    systemId: String(d.system_id),
    nodeId,
    mode,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    sshHost: sshHostFromDeployment(d),
  };
}

/**
 * All cluster members (for quorum / voters), sorted by node_id.
 * @param {Record<string, unknown>} cfg
 */
export function resolveAllKafkaDeployments(cfg) {
  const { deployments } = normalizeKafkaConfig(cfg);
  return [...deployments]
    .map((d) => finalizeDeployment(d))
    .sort((a, b) => a.nodeId - b.nodeId);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveKafkaDeployments(cfg, flags) {
  const { deployments } = normalizeKafkaConfig(cfg);
  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance);
  }

  if (!selectedId) {
    return resolveAllKafkaDeployments(cfg);
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [finalizeDeployment(d)];
}
