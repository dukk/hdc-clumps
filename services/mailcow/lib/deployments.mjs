import {
  deploymentSystemIdPattern,
  lxcSystemId,
  vmSystemId,
} from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  apiKeyVaultKey,
  dbpassVaultKey,
  dbrootVaultKey,
  installDir,
  normalizeDomainList,
  normalizeGitRef,
  normalizeHostname,
  redispassVaultKey,
  resolveAdminUrl,
} from "./mailcow-render.mjs";

const MAILCOW_ROLE = "mailcow";
const MAILCOW_LXC_SYSTEM_ID = deploymentSystemIdPattern(MAILCOW_ROLE);
const MAILCOW_QEMU_SYSTEM_ID = /^vm-mailcow-[a-z]+$/;

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
function normalizeV1(cfg) {
  const deploy = isObject(cfg.deploy) ? cfg.deploy : {};
  const mode = typeof deploy.mode === "string" ? deploy.mode.trim() : "";
  const systemId =
    typeof deploy.system_id === "string" && deploy.system_id.trim()
      ? deploy.system_id.trim()
      : lxcSystemId(MAILCOW_ROLE, "a");
  /** @type {Record<string, unknown>} */
  const defaults = { mode };
  if (isObject(cfg.proxmox)) defaults.proxmox = structuredClone(cfg.proxmox);
  if (isObject(cfg.mailcow)) defaults.mailcow = structuredClone(cfg.mailcow);
  if (isObject(cfg.install)) defaults.install = structuredClone(cfg.install);
  return {
    schemaVersion: 1,
    defaults,
    deployments: [{ system_id: systemId }],
  };
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeMailcowConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("mailcow config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (Array.isArray(cfg.deployments) && cfg.deployments.length > 0) {
    const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
    const raw = cfg.deployments.filter(isObject);
    if (!raw.length) {
      throw new Error("deployments[] is empty — add at least one entry");
    }
    const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
    validateDeployments(deployments);
    return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments };
  }
  if (isObject(cfg.deploy) || isObject(cfg.proxmox)) {
    const v1 = normalizeV1(cfg);
    const deployments = v1.deployments.map((entry) => mergeDeploymentEntry(v1.defaults, entry));
    validateDeployments(deployments);
    return { schemaVersion: 1, defaults: v1.defaults, deployments };
  }
  throw new Error("mailcow config needs deployments[] or legacy deploy + proxmox blocks");
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";

    if (mode === "proxmox-lxc") {
      if (!MAILCOW_LXC_SYSTEM_ID.test(sid)) {
        throw new Error(`system_id ${JSON.stringify(sid)} must match mailcow-<letter> for proxmox-lxc`);
      }
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
      if (!hostId) {
        throw new Error(`${sid}: proxmox.host_id required for proxmox-lxc`);
      }
      const lxc = isObject(px.lxc) ? px.lxc : {};
      const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
      if (!Number.isFinite(vmid) || vmid <= 0) {
        throw new Error(`${sid}: proxmox.lxc.vmid must be a positive number`);
      }
    } else if (mode === "proxmox-qemu" || mode === "configure-only") {
      if (!MAILCOW_QEMU_SYSTEM_ID.test(sid)) {
        throw new Error(`system_id ${JSON.stringify(sid)} must match vm-mailcow-<letter> for ${mode}`);
      }
      const configure = isObject(d.configure) ? d.configure : {};
      const ssh = isObject(configure.ssh) ? configure.ssh : {};
      const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
      if (!host) {
        throw new Error(`${sid}: configure.ssh.host required`);
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
        const ip = typeof q.ip === "string" ? q.ip.trim() : "";
        if (!ip) throw new Error(`${sid}: proxmox.qemu.ip required (CIDR)`);
        const templateVmid =
          typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid);
        if (!Number.isFinite(templateVmid) || templateVmid <= 0) {
          throw new Error(`${sid}: proxmox.qemu.template_vmid must be a positive number`);
        }
      }
    } else {
      throw new Error(`${sid}: unsupported mode ${JSON.stringify(mode)}`);
    }

    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const mc = isObject(d.mailcow) ? d.mailcow : {};
    normalizeHostname(mc);
  }
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listMailcowDeploymentSummaries(cfg) {
  const { deployments } = normalizeMailcowConfig(cfg);
  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : "proxmox-lxc";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmidRaw =
      mode === "proxmox-qemu" || mode === "configure-only"
        ? typeof q.vmid === "number"
          ? q.vmid
          : Number(q.vmid)
        : typeof lxc.vmid === "number"
          ? lxc.vmid
          : Number(lxc.vmid);
    const install = isObject(d.install) ? d.install : {};
    const mc = isObject(d.mailcow) ? d.mailcow : {};
    const configure = isObject(d.configure) ? d.configure : {};
    const ssh = isObject(configure.ssh) ? configure.ssh : {};
    let hostname = null;
    let adminUrl = null;
    try {
      hostname = normalizeHostname(mc);
      adminUrl = resolveAdminUrl(mc);
    } catch {
      hostname = null;
      adminUrl = null;
    }
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(vmidRaw) ? vmidRaw : null,
      ssh_host: typeof ssh.host === "string" ? ssh.host : null,
      install_enabled: install.enabled !== false,
      git_ref: normalizeGitRef(mc),
      hostname,
      admin_url: adminUrl,
      domain_count: normalizeDomainList(mc).length,
    };
  });
}

/**
 * @param {string | undefined} instance
 * @param {string} [defaultMode]
 */
export function instanceFlagToSystemId(instance, defaultMode) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (MAILCOW_LXC_SYSTEM_ID.test(t) || MAILCOW_QEMU_SYSTEM_ID.test(t)) return t;
  if (/^[a-z]+$/.test(t)) {
    if (defaultMode === "proxmox-qemu" || defaultMode === "configure-only") {
      return vmSystemId(MAILCOW_ROLE, t);
    }
    return lxcSystemId(MAILCOW_ROLE, t);
  }
  return vmSystemId(MAILCOW_ROLE, t);
}

/**
 * @param {Record<string, unknown>} mailcow
 */
export function apiKeyVaultKeyFromConfig(mailcow) {
  return apiKeyVaultKey(isObject(mailcow) ? mailcow : {});
}

/**
 * @param {Record<string, unknown>} mailcow
 */
export function dbSecretsVaultKeysFromConfig(mailcow) {
  const mc = isObject(mailcow) ? mailcow : {};
  return {
    dbpass: dbpassVaultKey(mc),
    dbroot: dbrootVaultKey(mc),
    redispass: redispassVaultKey(mc),
  };
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

/**
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 */
export function dataDiskStorageFromDeployment(deployment) {
  const px = deployment.proxmox;
  if (!isObject(px) || !isObject(px.qemu)) return "local-lvm";
  const q = px.qemu;
  const dataStorage =
    typeof q.data_disk_storage === "string" && q.data_disk_storage.trim()
      ? q.data_disk_storage.trim()
      : "";
  if (dataStorage) return dataStorage;
  return typeof q.storage === "string" && q.storage.trim() ? q.storage.trim() : "local-lvm";
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 */
function finalizeDeployment(d, skipInstallCli, skipInstallOpt) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli || skipInstallOpt === true) {
    install.enabled = false;
  }
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";
  return {
    systemId: String(d.system_id),
    mode,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    mailcow: isObject(d.mailcow) ? d.mailcow : {},
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveMailcowDeployments(cfg, flags, opts = {}) {
  const { defaults, deployments } = normalizeMailcowConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;
  const defaultMode =
    isObject(defaults) && typeof defaults.mode === "string" ? defaults.mode.trim() : "proxmox-lxc";

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance, defaultMode);
  }

  if (deployments.length === 1) {
    const d = deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [finalizeDeployment(d, skipInstallCli, opts.skipInstall)];
  }

  if (!selectedId) {
    return deployments.map((d) => finalizeDeployment(d, skipInstallCli, opts.skipInstall));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) {
    throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [finalizeDeployment(d, skipInstallCli, opts.skipInstall)];
}

/**
 * @param {Record<string, unknown>} install
 */
export function resolveInstallDir(install) {
  return installDir(isObject(install) ? install : {});
}
