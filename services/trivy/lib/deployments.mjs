import { deploymentSystemIdPattern, lxcSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const TRIVY_ROLE = "trivy";

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
      : lxcSystemId(TRIVY_ROLE, "a");
  /** @type {Record<string, unknown>} */
  const defaults = { mode };
  if (isObject(cfg.proxmox)) defaults.proxmox = structuredClone(cfg.proxmox);
  if (isObject(cfg.trivy)) defaults.trivy = structuredClone(cfg.trivy);
  if (isObject(cfg.install)) defaults.install = structuredClone(cfg.install);
  return { schemaVersion: 1, defaults, deployments: [{ system_id: systemId }] };
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeTrivyConfig(cfg) {
  if (!isObject(cfg)) throw new Error("trivy config must be a JSON object");
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (Array.isArray(cfg.deployments) && cfg.deployments.length > 0) {
    const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
    const raw = cfg.deployments.filter(isObject);
    if (!raw.length) throw new Error("deployments[] is empty - add at least one entry");
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
  throw new Error("trivy config needs deployments[] or legacy deploy + proxmox blocks");
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!deploymentSystemIdPattern(TRIVY_ROLE).test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match trivy-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const mode = typeof d.mode === "string" ? d.mode.trim() : "";
    if (mode === "proxmox-lxc" || mode === "" || !mode) {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
      if (!hostId) throw new Error(`${sid}: proxmox.host_id required for proxmox-lxc`);
      const lxc = isObject(px.lxc) ? px.lxc : {};
      const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
      if (!Number.isFinite(vmid) || vmid <= 0) {
        throw new Error(`${sid}: proxmox.lxc.vmid must be a positive number`);
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} trivy
 */
export function normalizeTrivyVersion(trivy) {
  const t = typeof trivy.version === "string" ? trivy.version.trim() : "";
  if (!t || t === "latest") return "v0.56.2";
  if (/^v\d/.test(t)) return t;
  if (/^\d/.test(t)) return `v${t}`;
  throw new Error(`trivy.version must be a release tag like v0.56.2 (got ${JSON.stringify(trivy.version)})`);
}

/**
 * @param {Record<string, unknown>} trivy
 */
export function trivyScanTargets(trivy) {
  const raw = Array.isArray(trivy.scan_targets) ? trivy.scan_targets : [];
  return raw.filter((r) => isObject(r) && typeof r.host === "string" && r.host.trim()).map((r) => {
    const paths = Array.isArray(r.paths) ? r.paths.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
    const dockerComposeDirs = Array.isArray(r.docker_compose_dirs)
      ? r.docker_compose_dirs.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
      : [];
    return {
      id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : null,
      host: String(r.host).trim(),
      ssh_user: typeof r.ssh_user === "string" && r.ssh_user.trim() ? r.ssh_user.trim() : null,
      paths,
      docker_compose_dirs: dockerComposeDirs,
    };
  });
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listTrivyDeploymentSummaries(cfg) {
  const { deployments } = normalizeTrivyConfig(cfg);
  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : "proxmox-lxc";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const install = isObject(d.install) ? d.install : {};
    const trivy = isObject(d.trivy) ? d.trivy : {};
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      install_enabled: install.enabled !== false,
      version: normalizeTrivyVersion(trivy),
      scan_target_count: trivyScanTargets(trivy).length,
    };
  });
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (deploymentSystemIdPattern(TRIVY_ROLE).test(t)) return t;
  return lxcSystemId(TRIVY_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 */
function finalizeDeployment(d, skipInstallCli, skipInstallOpt) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli || skipInstallOpt === true) install.enabled = false;
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";
  return {
    systemId: String(d.system_id),
    mode,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    trivy: isObject(d.trivy) ? d.trivy : {},
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveTrivyDeployments(cfg, flags, opts = {}) {
  const { deployments } = normalizeTrivyConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;
  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) selectedId = instanceFlagToSystemId(instance);
  if (deployments.length === 1) {
    const d = deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [finalizeDeployment(d, skipInstallCli, opts.skipInstall)];
  }
  if (!selectedId) return deployments.map((d) => finalizeDeployment(d, skipInstallCli, opts.skipInstall));
  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [finalizeDeployment(d, skipInstallCli, opts.skipInstall)];
}
