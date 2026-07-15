import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const POSTGRES_ROLE = "postgres";

/** @typedef {"standalone" | "primary" | "standby"} PostgresRole */

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
export function normalizePostgresqlConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("postgresql config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("postgresql config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const postgresql = isObject(cfg.postgresql)
    ? cfg.postgresql
    : isObject(defaults.postgresql)
      ? defaults.postgresql
      : {};
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments, postgresql };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  const byId = new Map();
  let standbyCount = 0;

  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!/^vm-postgres-[a-z]+$/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-postgres-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    byId.set(sid, d);

    const role = typeof d.role === "string" ? d.role.trim().toLowerCase() : "";
    if (role !== "standalone" && role !== "primary" && role !== "standby") {
      throw new Error(`${sid}: role must be standalone, primary, or standby`);
    }
    if (role === "standby") {
      standbyCount += 1;
      const primaryId =
        typeof d.primary_system_id === "string" ? d.primary_system_id.trim() : "";
      if (!primaryId) {
        throw new Error(`${sid}: primary_system_id required for standby`);
      }
      const primary = byId.get(primaryId);
      if (primary && typeof primary.role === "string" && primary.role.trim().toLowerCase() !== "primary") {
        throw new Error(`${sid}: primary_system_id ${JSON.stringify(primaryId)} must reference role primary`);
      }
    }

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

  for (const d of deployments) {
    const role = typeof d.role === "string" ? d.role.trim().toLowerCase() : "";
    if (role === "standby") {
      const primaryId =
        typeof d.primary_system_id === "string" ? d.primary_system_id.trim() : "";
      const primary = byId.get(primaryId);
      if (!primary) {
        throw new Error(
          `${d.system_id}: primary_system_id ${JSON.stringify(primaryId)} not found in deployments[]`,
        );
      }
      if (typeof primary.role !== "string" || primary.role.trim().toLowerCase() !== "primary") {
        throw new Error(`${d.system_id}: ${JSON.stringify(primaryId)} must have role primary`);
      }
    }
  }

  if (standbyCount > 0) {
    const primaryCount = deployments.filter(
      (x) => typeof x.role === "string" && x.role.trim().toLowerCase() === "primary",
    ).length;
    if (primaryCount < 1) {
      throw new Error("deployments with standby require at least one primary");
    }
  }
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (/^vm-postgres-[a-z]+$/.test(t)) return t;
  return vmSystemId(POSTGRES_ROLE, t);
}

/**
 * @param {PostgresRole} role
 */
function deploySortKey(role) {
  if (role === "standalone" || role === "primary") return 0;
  return 1;
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 */
function finalizeDeployment(d, skipInstallCli) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli) install.enabled = false;
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-qemu";
  const role = typeof d.role === "string" ? d.role.trim().toLowerCase() : "standalone";
  return {
    systemId: String(d.system_id),
    mode,
    role: /** @type {PostgresRole} */ (role),
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    primarySystemId:
      typeof d.primary_system_id === "string" ? d.primary_system_id.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    databases: Array.isArray(d.databases) ? d.databases : [],
    roles: Array.isArray(d.roles) ? d.roles : [],
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolvePostgresqlDeployments(cfg, flags) {
  const { deployments } = normalizePostgresqlConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

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
    return [finalizeDeployment(d, skipInstallCli)];
  }

  if (!selectedId) {
    const sorted = [...deployments].sort((a, b) => {
      const ra =
        typeof a.role === "string"
          ? deploySortKey(/** @type {PostgresRole} */ (a.role.trim().toLowerCase()))
          : 0;
      const rb =
        typeof b.role === "string"
          ? deploySortKey(/** @type {PostgresRole} */ (b.role.trim().toLowerCase()))
          : 0;
      return ra - rb;
    });
    return sorted.map((d) => finalizeDeployment(d, skipInstallCli));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [finalizeDeployment(d, skipInstallCli)];
}

/**
 * @param {ReturnType<typeof normalizePostgresqlConfig>} normalized
 */
export function postgresqlGlobalSettings(normalized) {
  const pg = isObject(normalized.postgresql) ? normalized.postgresql : {};
  return {
    versionMajor:
      typeof pg.version_major === "number" && pg.version_major > 0
        ? pg.version_major
        : Number(pg.version_major) || 16,
    listenAddresses:
      typeof pg.listen_addresses === "string" && pg.listen_addresses.trim()
        ? pg.listen_addresses.trim()
        : "*",
    listenCidrs: Array.isArray(pg.listen_cidrs)
      ? pg.listen_cidrs.map((c) => String(c).trim()).filter(Boolean)
      : ["192.0.2.0/24", "127.0.0.0/8"],
    superuserVaultKey:
      typeof pg.superuser_vault_key === "string" && pg.superuser_vault_key.trim()
        ? pg.superuser_vault_key.trim()
        : "HDC_POSTGRESQL_SUPERUSER_PASSWORD",
    replicationVaultKey:
      typeof pg.replication_vault_key === "string" && pg.replication_vault_key.trim()
        ? pg.replication_vault_key.trim()
        : "HDC_POSTGRESQL_REPLICATION_PASSWORD",
    replicationUser:
      typeof pg.replication_user === "string" && pg.replication_user.trim()
        ? pg.replication_user.trim()
        : "replicator",
    databases: Array.isArray(pg.databases) ? pg.databases : [],
    roles: Array.isArray(pg.roles) ? pg.roles : [],
  };
}

/**
 * @param {ReturnType<typeof resolvePostgresqlDeployments>} deployments
 */
export function hasStandbyDeployments(deployments) {
  return deployments.some((d) => d.role === "standby");
}

/**
 * @param {ReturnType<typeof resolvePostgresqlDeployments>} allDeployments
 * @param {string} primarySystemId
 */
export function findPrimaryDeployment(allDeployments, primarySystemId) {
  return allDeployments.find((d) => d.systemId === primarySystemId && d.role === "primary") ?? null;
}

/**
 * SSH host from deployment configure block.
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 */
export function sshHostFromDeployment(deployment) {
  const cfg = deployment.configure;
  if (!isObject(cfg) || !isObject(cfg.ssh)) return "";
  const host = typeof cfg.ssh.host === "string" ? cfg.ssh.host.trim() : "";
  return host;
}

/**
 * @param {ReturnType<typeof resolvePostgresqlDeployments>} allDeployments
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 */
export function databasesForDeployment(global, deployment) {
  const local = deployment.databases.filter(isObject);
  return local.length ? local : global.databases.filter(isObject);
}

/**
 * @param {ReturnType<typeof resolvePostgresqlDeployments>} allDeployments
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 */
export function rolesForDeployment(global, deployment) {
  const local = deployment.roles.filter(isObject);
  return local.length ? local : global.roles.filter(isObject);
}
