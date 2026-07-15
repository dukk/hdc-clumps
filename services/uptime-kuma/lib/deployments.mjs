import {
  lxcSystemId,
  uptimeKumaDeploymentSystemIdPattern,
} from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const UPTIME_KUMA_ROLE = "uptime-kuma";

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
      : lxcSystemId(UPTIME_KUMA_ROLE, "a");
  /** @type {Record<string, unknown>} */
  const defaults = { mode };
  if (isObject(cfg.proxmox)) defaults.proxmox = structuredClone(cfg.proxmox);
  if (isObject(cfg.uptime_kuma)) defaults.uptime_kuma = structuredClone(cfg.uptime_kuma);
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
export function normalizeUptimeKumaConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("uptime-kuma config must be a JSON object");
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
  throw new Error("uptime-kuma config needs deployments[] or legacy deploy + proxmox blocks");
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!uptimeKumaDeploymentSystemIdPattern().test(sid)) {
      throw new Error(
        `system_id ${JSON.stringify(sid)} must match uptime-kuma-<letter> or uptime-kuma-ext-<letter>`,
      );
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const mode = typeof d.mode === "string" ? d.mode.trim() : "";
    if (mode === "oci-vm") {
      const oci = isObject(d.oci) ? d.oci : {};
      const instanceId = typeof oci.instance_id === "string" ? oci.instance_id.trim() : "";
      if (!instanceId) {
        throw new Error(`${sid}: oci.instance_id required for oci-vm`);
      }
    } else if (mode === "proxmox-lxc" || mode === "" || !mode) {
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
    } else {
      throw new Error(`${sid}: unsupported mode ${JSON.stringify(mode)}`);
    }
  }
}

/**
 * Per-deployment config slice for monitor/status-page/notification sync.
 * Deployment-owned arrays replace root arrays when present on the deployment entry.
 *
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, unknown>} deployment
 */
export function resolveDeploymentConfigSlice(cfg, deployment) {
  const defaults = isObject(cfg.defaults) ? cfg.defaults : {};
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(deployment, key);

  /** @type {Record<string, unknown>} */
  const auth = {};
  if (isObject(cfg.uptime_kuma_auth)) deepMerge(auth, structuredClone(cfg.uptime_kuma_auth));
  if (isObject(defaults.uptime_kuma_auth)) deepMerge(auth, structuredClone(defaults.uptime_kuma_auth));
  if (isObject(deployment.uptime_kuma_auth)) deepMerge(auth, structuredClone(deployment.uptime_kuma_auth));

  return {
    system_id: deployment.system_id,
    uptime_kuma_auth: auth,
    monitors: hasOwn("monitors") ? deployment.monitors : (cfg.monitors ?? []),
    tags: hasOwn("tags") ? deployment.tags : (cfg.tags ?? defaults.tags ?? []),
    status_pages: hasOwn("status_pages") ? deployment.status_pages : (cfg.status_pages ?? []),
    notifications: hasOwn("notifications")
      ? deployment.notifications
      : (cfg.notifications ?? defaults.notifications ?? []),
    configure: isObject(deployment.configure)
      ? deployment.configure
      : isObject(defaults.configure)
        ? defaults.configure
        : {},
    mode: typeof deployment.mode === "string" ? deployment.mode : "proxmox-lxc",
    proxmox: isObject(deployment.proxmox) ? deployment.proxmox : null,
    uptime_kuma: isObject(deployment.uptime_kuma) ? deployment.uptime_kuma : {},
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveDeploymentConfigSlicesForSync(cfg, flags) {
  const { defaults, deployments } = normalizeUptimeKumaConfig(cfg);
  const selected = resolveUptimeKumaDeployments(cfg, flags, { skipInstall: true });
  const selectedIds = new Set(selected.map((d) => d.systemId));
  return deployments
    .filter((d) => selectedIds.has(String(d.system_id)))
    .map((d) => ({
      systemId: String(d.system_id),
      slice: resolveDeploymentConfigSlice(cfg, d),
      defaults,
      deployment: d,
    }));
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listUptimeKumaDeploymentSummaries(cfg) {
  const { deployments } = normalizeUptimeKumaConfig(cfg);
  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : "proxmox-lxc";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const install = isObject(d.install) ? d.install : {};
    const uk = isObject(d.uptime_kuma) ? d.uptime_kuma : {};
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      install_enabled: install.enabled !== false,
      port: typeof uk.port === "number" ? uk.port : Number(uk.port) || 3001,
      release: typeof uk.release === "string" ? uk.release : "latest",
    };
  });
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  const pattern = uptimeKumaDeploymentSystemIdPattern();
  if (pattern.test(t)) return t;
  if (/^ext-[a-z]+$/.test(t)) return `${UPTIME_KUMA_ROLE}-${t}`;
  return lxcSystemId(UPTIME_KUMA_ROLE, t);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveUptimeKumaDeployments(cfg, flags, opts = {}) {
  const { deployments } = normalizeUptimeKumaConfig(cfg);
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
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    oci: isObject(d.oci) ? d.oci : null,
    configure: isObject(d.configure) ? d.configure : {},
    uptimeKuma: isObject(d.uptime_kuma) ? d.uptime_kuma : {},
    install,
  };
}
