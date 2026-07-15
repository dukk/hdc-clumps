import { deploymentSystemIdPattern, lxcSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { hostPort, normalizeImageTag, parsePublicUrl } from "./hdc-agents-render.mjs";

const HDC_AGENTS_ROLE = "hdc-agents";

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
export function normalizeHdcAgentsConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("hdc-agents config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 2;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("deployments[] is required");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  return { schemaVersion: version, defaults, deployments };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!deploymentSystemIdPattern(HDC_AGENTS_ROLE).test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match hdc-agents-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const block = isObject(d.hdc_agents) ? d.hdc_agents : {};
    normalizeImageTag(block);
    if (block.public_url !== null && block.public_url !== undefined) {
      const s = typeof block.public_url === "string" ? block.public_url.trim() : "";
      if (s) parsePublicUrl(block);
    }
  }
}

/**
 * @param {Record<string, unknown>} d
 */
function finalizeDeployment(d, skipInstall) {
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";
  const systemId = String(d.system_id).trim();
  const hdc_agents = isObject(d.hdc_agents) ? d.hdc_agents : {};
  const install = isObject(d.install) ? { ...d.install } : {};
  if (skipInstall) install.enabled = false;
  return {
    mode,
    systemId,
    proxmox: isObject(d.proxmox) ? d.proxmox : {},
    hdc_agents,
    install,
    host_port: hostPort(hdc_agents),
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveHdcAgentsDeployments(cfg, flags = {}) {
  const { deployments } = normalizeHdcAgentsConfig(cfg);
  const skipInstall = flagGet(flags, "skip-install") !== undefined;
  const systemIdFlag = flagGet(flags, "system-id");
  const instance = flagGet(flags, "instance");
  let selected = deployments;
  if (systemIdFlag) {
    selected = deployments.filter((d) => String(d.system_id).trim() === systemIdFlag);
  } else if (instance) {
    const want = lxcSystemId(HDC_AGENTS_ROLE, instance);
    selected = deployments.filter((d) => String(d.system_id).trim() === want);
  }
  if (!selected.length) {
    throw new Error("no matching hdc-agents deployment for the given filters");
  }
  return selected.map((d) => finalizeDeployment(d, skipInstall));
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listHdcAgentsDeploymentSummaries(cfg) {
  const { deployments } = normalizeHdcAgentsConfig(cfg);
  return deployments.map((d) => {
    const hdc_agents = isObject(d.hdc_agents) ? d.hdc_agents : {};
    return {
      system_id: d.system_id,
      mode: d.mode ?? "proxmox-lxc",
      host_port: hostPort(hdc_agents),
    };
  });
}
