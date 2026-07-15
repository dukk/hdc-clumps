import {
  deploymentSystemIdPattern,
  lxcSystemId,
  vmSystemId,
} from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const IMMICH_ROLE = "immich";
const IMMICH_LXC_SYSTEM_ID = deploymentSystemIdPattern(IMMICH_ROLE);
const IMMICH_QEMU_SYSTEM_ID = /^vm-immich-[a-z]+$/;

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
export function normalizeImmichConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("immich config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("immich config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";

    if (mode === "synology-docker") {
      if (!IMMICH_LXC_SYSTEM_ID.test(sid)) {
        throw new Error(`system_id ${JSON.stringify(sid)} must match immich-<letter> for synology-docker`);
      }
      const syn = isObject(d.synology) ? d.synology : {};
      const instance = typeof syn.instance === "string" ? syn.instance.trim() : "";
      if (!instance) {
        throw new Error(`${sid}: synology.instance required for synology-docker (e.g. "a")`);
      }
    } else if (mode === "proxmox-qemu" || mode === "configure-only") {
      if (!IMMICH_QEMU_SYSTEM_ID.test(sid)) {
        throw new Error(`system_id ${JSON.stringify(sid)} must match vm-immich-<letter> for ${mode}`);
      }
      const configure = isObject(d.configure) ? d.configure : {};
      const ssh = isObject(configure.ssh) ? configure.ssh : {};
      const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
      if (!host) {
        throw new Error(`${sid}: configure.ssh.host required`);
      }
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
    } else {
      throw new Error(`${sid}: unsupported mode ${JSON.stringify(mode)}`);
    }

    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
  }
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (IMMICH_LXC_SYSTEM_ID.test(t) || IMMICH_QEMU_SYSTEM_ID.test(t)) return t;
  if (/^[a-z]+$/.test(t)) return lxcSystemId(IMMICH_ROLE, t);
  return vmSystemId(IMMICH_ROLE, t);
}

/**
 * @param {Record<string, unknown>} immich
 */
export function dbPasswordVaultKey(immich) {
  const key =
    typeof immich.db_password_vault_key === "string" && immich.db_password_vault_key.trim()
      ? immich.db_password_vault_key.trim()
      : "HDC_IMMICH_DB_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listImmichDeploymentSummaries(cfg) {
  const { deployments } = normalizeImmichConfig(cfg);
  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : "proxmox-qemu";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    const install = isObject(d.install) ? d.install : {};
    const immich = isObject(d.immich) ? d.immich : {};
    const port = typeof immich.port === "number" ? immich.port : Number(immich.port);
    const configure = isObject(d.configure) ? d.configure : {};
    const ssh = isObject(configure.ssh) ? configure.ssh : {};
    const syn = isObject(d.synology) ? d.synology : {};
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      ssh_host: typeof ssh.host === "string" ? ssh.host : null,
      synology_instance: typeof syn.instance === "string" ? syn.instance : null,
      install_enabled: install.enabled !== false,
      release: typeof immich.release === "string" ? immich.release : "latest",
      port: Number.isFinite(port) ? port : 2283,
      public_url:
        typeof immich.public_url === "string" && immich.public_url.trim()
          ? immich.public_url.trim()
          : null,
    };
  });
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
 * Proxmox storage for the optional data disk (scsi1). Falls back to qemu.storage.
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
 */
export function finalizeDeployment(d, skipInstallCli) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli) install.enabled = false;
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-qemu";
  return {
    systemId: String(d.system_id),
    mode,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    synology: isObject(d.synology) ? d.synology : {},
    immich: isObject(d.immich) ? d.immich : {},
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveImmichDeployments(cfg, flags) {
  const { deployments } = normalizeImmichConfig(cfg);
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
    return deployments.map((d) => finalizeDeployment(d, skipInstallCli));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) {
    throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [finalizeDeployment(d, skipInstallCli)];
}
