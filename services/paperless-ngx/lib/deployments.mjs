import { deploymentSystemIdPattern, lxcSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  dbPasswordVaultKey,
  hostPort,
  normalizeImageTag,
  normalizePostgresImageTag,
  normalizeRedisImageTag,
  parsePublicUrl,
  secretKeyVaultKey,
  tikaEnabled,
} from "./paperless-ngx-render.mjs";

const PAPERLESS_ROLE = "paperless-ngx";

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
      : lxcSystemId(PAPERLESS_ROLE, "a");
  /** @type {Record<string, unknown>} */
  const defaults = { mode };
  if (isObject(cfg.proxmox)) defaults.proxmox = structuredClone(cfg.proxmox);
  if (isObject(cfg.paperless_ngx)) defaults.paperless_ngx = structuredClone(cfg.paperless_ngx);
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
export function normalizePaperlessNgxConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("paperless-ngx config must be a JSON object");
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
  throw new Error("paperless-ngx config needs deployments[] or legacy deploy + proxmox blocks");
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!deploymentSystemIdPattern(PAPERLESS_ROLE).test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match paperless-ngx-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const paperless = isObject(d.paperless_ngx) ? d.paperless_ngx : {};
    const publicUrl = typeof paperless.public_url === "string" ? paperless.public_url.trim() : "";
    if (publicUrl) {
      parsePublicUrl(paperless);
    }
    const mode = typeof d.mode === "string" ? d.mode.trim() : "";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) {
      throw new Error(`${sid}: proxmox.host_id required`);
    }

    if (mode === "proxmox-qemu") {
      const q = isObject(px.qemu) ? px.qemu : {};
      const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
      if (!Number.isFinite(vmid) || vmid <= 0) {
        throw new Error(`${sid}: proxmox.qemu.vmid must be a positive number`);
      }
      const templateVmid =
        typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid);
      if (!Number.isFinite(templateVmid) || templateVmid <= 0) {
        throw new Error(`${sid}: proxmox.qemu.template_vmid must be a positive number`);
      }
      const ip = typeof q.ip === "string" ? q.ip.trim() : "";
      if (!ip) {
        throw new Error(`${sid}: proxmox.qemu.ip required (static CIDR for cloud-init)`);
      }
    } else if (mode === "proxmox-lxc" || mode === "" || !mode) {
      const lxc = isObject(px.lxc) ? px.lxc : {};
      const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
      if (!Number.isFinite(vmid) || vmid <= 0) {
        throw new Error(`${sid}: proxmox.lxc.vmid must be a positive number`);
      }
    } else {
      throw new Error(`${sid}: unsupported mode ${JSON.stringify(mode)}`);
    }
  }
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listPaperlessNgxDeploymentSummaries(cfg) {
  const { deployments } = normalizePaperlessNgxConfig(cfg);
  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : "proxmox-lxc";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const qemu = isObject(px.qemu) ? px.qemu : {};
    const lxcVmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const qemuVmid = typeof qemu.vmid === "number" ? qemu.vmid : Number(qemu.vmid);
    const vmid =
      mode === "proxmox-qemu"
        ? Number.isFinite(qemuVmid)
          ? qemuVmid
          : null
        : Number.isFinite(lxcVmid)
          ? lxcVmid
          : null;
    const configure = isObject(d.configure) ? d.configure : {};
    const ssh = isObject(configure.ssh) ? configure.ssh : {};
    const install = isObject(d.install) ? d.install : {};
    const paperless = isObject(d.paperless_ngx) ? d.paperless_ngx : {};
    let publicUrl = null;
    try {
      const parsed = parsePublicUrl(paperless);
      publicUrl = parsed ? parsed.origin.replace(/\/+$/, "") : null;
    } catch {
      publicUrl = null;
    }
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      ssh_host: typeof ssh.host === "string" ? ssh.host : null,
      qemu_ip: typeof qemu.ip === "string" ? qemu.ip : null,
      install_enabled: install.enabled !== false,
      image_tag: normalizeImageTag(paperless),
      postgres_image_tag: normalizePostgresImageTag(paperless),
      redis_image_tag: normalizeRedisImageTag(paperless),
      host_port: hostPort(paperless),
      tika_enabled: tikaEnabled(paperless),
      public_url: publicUrl,
      timezone: typeof paperless.timezone === "string" ? paperless.timezone : null,
    };
  });
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (deploymentSystemIdPattern(PAPERLESS_ROLE).test(t)) return t;
  return lxcSystemId(PAPERLESS_ROLE, t);
}

/**
 * @param {Record<string, unknown>} paperless
 */
export function secretKeyVaultKeyFromConfig(paperless) {
  return secretKeyVaultKey(isObject(paperless) ? paperless : {});
}

/**
 * @param {Record<string, unknown>} paperless
 */
export function dbPasswordVaultKeyFromConfig(paperless) {
  return dbPasswordVaultKey(isObject(paperless) ? paperless : {});
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
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : null,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : {},
    paperless_ngx: isObject(d.paperless_ngx) ? d.paperless_ngx : {},
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolvePaperlessNgxDeployments(cfg, flags, opts = {}) {
  const { deployments } = normalizePaperlessNgxConfig(cfg);
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
