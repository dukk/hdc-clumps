import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const SPLUNK_ROLE = "splunk";
const REQUIRED_DEPLOYMENTS = 1;

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
export function normalizeSplunkConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("splunk config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("splunk config needs deployments[] with exactly one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const splunk = isObject(cfg.splunk)
    ? cfg.splunk
    : isObject(defaults.splunk)
      ? defaults.splunk
      : {};
  return { schemaVersion: version, defaults, deployments, splunk };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  if (deployments.length !== REQUIRED_DEPLOYMENTS) {
    throw new Error(
      `splunk requires exactly ${REQUIRED_DEPLOYMENTS} deployment (no clustering); found ${deployments.length}`,
    );
  }
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("deployment needs system_id");
    if (!/^vm-splunk-[a-z]+$/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-splunk-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const role = typeof d.role === "string" ? d.role.trim().toLowerCase() : "standalone";
    if (role !== "standalone") {
      throw new Error(`${sid}: role must be standalone (Splunk Free does not support clustering)`);
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
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (/^vm-splunk-[a-z]+$/.test(t)) return t;
  return vmSystemId(SPLUNK_ROLE, t);
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
    role,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    splunk: isObject(d.splunk) ? d.splunk : {},
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveSplunkDeployments(cfg, flags) {
  const { deployments } = normalizeSplunkConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance);
  }

  const d = deployments[0];
  if (selectedId && selectedId !== d.system_id) {
    throw new Error(
      `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
    );
  }
  return [finalizeDeployment(d, skipInstallCli)];
}

/**
 * @param {ReturnType<typeof normalizeSplunkConfig>} normalized
 */
export function splunkGlobalSettings(normalized) {
  const sp = isObject(normalized.splunk) ? normalized.splunk : {};
  const version = typeof sp.version === "string" && sp.version.trim() ? sp.version.trim() : "";
  const build = typeof sp.build === "string" && sp.build.trim() ? sp.build.trim() : "";
  if (!version) throw new Error("splunk.version required in config");
  if (!build || build.includes("REPLACE")) {
    throw new Error("splunk.build required — copy from Splunk download page (deb filename build id)");
  }
  const license = typeof sp.license === "string" ? sp.license.trim().toLowerCase() : "free";
  if (license !== "free") {
    throw new Error('splunk.license must be "free" for this package');
  }
  return {
    version,
    build,
    license,
    adminVaultKey:
      typeof sp.admin_vault_key === "string" && sp.admin_vault_key.trim()
        ? sp.admin_vault_key.trim()
        : "HDC_SPLUNK_ADMIN_PASSWORD",
    httpPort:
      typeof sp.http_port === "number" && sp.http_port > 0 ? sp.http_port : Number(sp.http_port) || 8000,
    mgmtPort:
      typeof sp.mgmt_port === "number" && sp.mgmt_port > 0 ? sp.mgmt_port : Number(sp.mgmt_port) || 8089,
    splunkHome:
      typeof sp.splunk_home === "string" && sp.splunk_home.trim()
        ? sp.splunk_home.trim()
        : "/opt/splunk",
    varMount:
      typeof sp.var_mount === "string" && sp.var_mount.trim() ? sp.var_mount.trim() : "/opt/splunk/var",
    inputs: Array.isArray(sp.inputs) ? sp.inputs.filter(isObject) : [],
  };
}

/**
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 * @param {ReturnType<typeof splunkGlobalSettings>} global
 */
export function splunkSettingsForDeployment(deployment, global) {
  const local = isObject(deployment.splunk) ? deployment.splunk : {};
  const serverName =
    typeof local.server_name === "string" && local.server_name.trim()
      ? local.server_name.trim()
      : deployment.hostname || deployment.systemId.replace(/^vm-/, "");
  const inputs = Array.isArray(local.inputs) ? local.inputs.filter(isObject) : global.inputs;
  return { serverName, inputs };
}

/**
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 */
export function sshHostFromDeployment(deployment) {
  const cfg = deployment.configure;
  if (!isObject(cfg) || !isObject(cfg.ssh)) return "";
  return typeof cfg.ssh.host === "string" ? cfg.ssh.host.trim() : "";
}

/**
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 */
export function dataDiskGbFromDeployment(deployment) {
  const px = deployment.proxmox;
  if (!isObject(px) || !isObject(px.qemu)) return 0;
  const gb = typeof px.qemu.data_disk_gb === "number" ? px.qemu.data_disk_gb : Number(px.qemu.data_disk_gb);
  return Number.isFinite(gb) && gb > 0 ? gb : 0;
}
