import { deploymentSystemIdPattern, lxcSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  adminPasswordVaultKey,
  apiTokenVaultKey,
  mgtPort,
  postgresVaultKey,
  validateSiteConfig,
} from "./safeline-render.mjs";

const SAFELINE_ROLE = "safeline";

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
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown>} entry
 */
export function resolveSitesForDeployment(defaults, entry) {
  const fromDefaults = Array.isArray(defaults.sites) ? defaults.sites.filter(isObject) : [];
  const fromEntry = Array.isArray(entry.sites) ? entry.sites.filter(isObject) : [];
  const merged = fromEntry.length ? fromEntry : fromDefaults;
  for (const site of merged) validateSiteConfig(site);
  return merged;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeSafelineConfig(cfg) {
  if (!isObject(cfg)) throw new Error("safeline config must be a JSON object");
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || !cfg.deployments.length) {
    throw new Error("deployments[] is empty — add at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments, defaults);
  return { schemaVersion: version, defaults, deployments };
}

/**
 * @param {Record<string, unknown>[]} deployments
 * @param {Record<string, unknown>} defaults
 */
function validateDeployments(deployments, defaults) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!deploymentSystemIdPattern(SAFELINE_ROLE).test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match safeline-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-lxc";
    if (mode !== "proxmox-lxc") throw new Error(`${sid}: only proxmox-lxc is supported in v1`);
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) throw new Error(`${sid}: proxmox.host_id required`);
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error(`${sid}: proxmox.lxc.vmid must be a positive number`);
    }
    resolveSitesForDeployment(defaults, d);
  }
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listSafelineDeploymentSummaries(cfg) {
  const { defaults, deployments } = normalizeSafelineConfig(cfg);
  return deployments.map((d) => {
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const safeline = isObject(d.safeline) ? d.safeline : {};
    const sites = resolveSitesForDeployment(defaults, d);
    return {
      system_id: d.system_id,
      mode: typeof d.mode === "string" ? d.mode : "proxmox-lxc",
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      mgt_port: mgtPort(safeline),
      image_tag: typeof safeline.image_tag === "string" ? safeline.image_tag : null,
      sites_count: sites.length,
      site_ids: sites.map((s) => String(s.id)),
      postgres_vault_key: postgresVaultKey(safeline),
      api_token_vault_key: apiTokenVaultKey(safeline),
      admin_password_vault_key: adminPasswordVaultKey(safeline),
    };
  });
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (deploymentSystemIdPattern(SAFELINE_ROLE).test(t)) return t;
  return lxcSystemId(SAFELINE_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 * @param {Record<string, unknown>} defaults
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 */
function finalizeDeployment(d, defaults, skipInstallCli, skipInstallOpt) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli || skipInstallOpt === true) install.enabled = false;
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";
  return {
    systemId: String(d.system_id),
    mode,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    safeline: isObject(d.safeline) ? d.safeline : {},
    install,
    sites: resolveSitesForDeployment(defaults, d),
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveSafelineDeployments(cfg, flags, opts = {}) {
  const { defaults, deployments } = normalizeSafelineConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) selectedId = instanceFlagToSystemId(instance);

  const finalize = (d) => finalizeDeployment(d, defaults, skipInstallCli, opts.skipInstall);

  if (deployments.length === 1) {
    const d = deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [finalize(d)];
  }
  if (!selectedId) return deployments.map(finalize);
  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [finalize(d)];
}
