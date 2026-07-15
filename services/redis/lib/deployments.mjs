import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";

const REDIS_ROLE = "redis";

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
export function normalizeRedisConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("redis config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("redis config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  const redis = isObject(cfg.redis) ? cfg.redis : isObject(defaults.redis) ? defaults.redis : {};
  const minMasters =
    typeof redis.min_masters === "number" && redis.min_masters > 0
      ? redis.min_masters
      : Number(redis.min_masters) || 3;
  validateDeployments(deployments, minMasters);
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments, redis, minMasters };
}

/**
 * @param {Record<string, unknown>[]} deployments
 * @param {number} minMasters
 */
function validateDeployments(deployments, minMasters) {
  if (deployments.length !== minMasters) {
    throw new Error(
      `redis cluster requires exactly ${minMasters} deployments (found ${deployments.length})`,
    );
  }
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!/^vm-redis-[a-z]+$/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-redis-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
    if (mode === "proxmox-qemu" || mode === "configure-only") {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      if (mode === "proxmox-qemu") {
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        if (!hostId) throw new Error(`${sid}: proxmox.host_id required for proxmox-qemu`);
        const q = isObject(px.qemu) ? px.qemu : {};
        const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
        if (!Number.isFinite(vmid) || vmid <= 0) {
          throw new Error(`${sid}: proxmox.qemu.vmid must be a positive number`);
        }
      }
      const configure = isObject(d.configure) ? d.configure : {};
      const ssh = isObject(configure.ssh) ? configure.ssh : {};
      const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
      if (!host) {
        throw new Error(`${sid}: configure.ssh.host required`);
      }
    }
  }
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (/^vm-redis-[a-z]+$/.test(t)) return t;
  return vmSystemId(REDIS_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 */
function finalizeDeployment(d, skipInstallCli) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli) install.enabled = false;
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-qemu";
  return {
    systemId: String(d.system_id),
    mode,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveRedisDeployments(cfg, flags) {
  const { deployments } = normalizeRedisConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance);
  }

  if (!selectedId) {
    const sorted = [...deployments].sort((a, b) =>
      String(a.system_id).localeCompare(String(b.system_id)),
    );
    return sorted.map((d) => finalizeDeployment(d, skipInstallCli));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [finalizeDeployment(d, skipInstallCli)];
}

/**
 * @param {ReturnType<typeof normalizeRedisConfig>} normalized
 */
export function redisGlobalSettings(normalized) {
  const r = isObject(normalized.redis) ? normalized.redis : {};
  return {
    port: typeof r.port === "number" && r.port > 0 ? r.port : Number(r.port) || 6379,
    passwordVaultKey:
      typeof r.password_vault_key === "string" && r.password_vault_key.trim()
        ? r.password_vault_key.trim()
        : "HDC_REDIS_PASSWORD",
    clusterReplicas:
      typeof r.cluster_replicas === "number" && r.cluster_replicas >= 0
        ? r.cluster_replicas
        : Number(r.cluster_replicas) || 0,
    minMasters: normalized.minMasters,
    maxmemory:
      typeof r.maxmemory === "string" && r.maxmemory.trim() ? r.maxmemory.trim() : "512mb",
    maxmemoryPolicy:
      typeof r.maxmemory_policy === "string" && r.maxmemory_policy.trim()
        ? r.maxmemory_policy.trim()
        : "allkeys-lru",
  };
}

/**
 * SSH host from deployment configure block.
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 */
export function sshHostFromDeployment(deployment) {
  const cfg = deployment.configure;
  if (!isObject(cfg) || !isObject(cfg.ssh)) return "";
  return typeof cfg.ssh.host === "string" ? cfg.ssh.host.trim() : "";
}

/**
 * SSH target from deployment configure block.
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 * @param {string} [defaultHost] Used when configure.ssh.host is omitted.
 */
export function sshTargetFromDeployment(deployment, defaultHost = "") {
  const cfg = deployment.configure;
  const ssh = isObject(cfg) && isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  const host =
    typeof ssh.host === "string" && ssh.host.trim()
      ? ssh.host.trim()
      : typeof defaultHost === "string"
        ? defaultHost.trim()
        : "";
  if (!host) {
    throw new Error(`${deployment.systemId}: configure.ssh.host required`);
  }
  return { user, host };
}

/**
 * @param {ReturnType<typeof resolveRedisDeployments>} deployments
 * @param {ReturnType<typeof redisGlobalSettings>} global
 * @returns {{ host: string; port: number; user: string; systemId: string }[]}
 */
export function clusterEndpointsFromDeployments(deployments, global) {
  return deployments.map((d) => {
    const { user, host } = sshTargetFromDeployment(d);
    return {
      systemId: d.systemId,
      user,
      host,
      port: global.port,
    };
  });
}
