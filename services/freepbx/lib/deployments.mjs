import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const VM_ID_PATTERN = /^vm-freepbx-[a-z]+$/;

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
export function freepbxBlock(cfg) {
  return isObject(cfg.freepbx) ? cfg.freepbx : {};
}

/**
 * @param {Record<string, unknown>} defaults
 * @param {unknown} pxRaw
 */
export function mergedProxmoxBlock(defaults, pxRaw) {
  const base =
    isObject(defaults.proxmox) ? structuredClone(defaults.proxmox) : {};
  if (isObject(pxRaw)) deepMerge(base, pxRaw);
  return base;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeFreepbxConfig(cfg) {
  if (!isObject(cfg)) throw new Error("freepbx config must be a JSON object");
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("freepbx config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const deployments = cfg.deployments.filter(isObject).map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  return {
    schemaVersion: typeof cfg.schema_version === "number" ? cfg.schema_version : 1,
    defaults,
    freepbx: freepbxBlock(cfg),
    deployments,
  };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!VM_ID_PATTERN.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-freepbx-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-qemu";
    if (mode !== "proxmox-qemu") throw new Error(`${sid}: only proxmox-qemu mode is supported`);
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) throw new Error(`${sid}: proxmox.host_id required`);
    const q = isObject(px.qemu) ? px.qemu : {};
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(ip)) {
      throw new Error(`${sid}: proxmox.qemu.ip must be CIDR`);
    }
    const templateVmid = Number(q.template_vmid);
    if (!Number.isFinite(templateVmid) || templateVmid <= 0) {
      throw new Error(`${sid}: proxmox.qemu.template_vmid must be a positive number`);
    }
  }
}

/**
 * @param {string | undefined} instance
 * @param {Record<string, unknown>[]} deployments
 */
export function instanceFlagToSystemId(instance, deployments) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (VM_ID_PATTERN.test(t)) return t;
  const hit = deployments.find(
    (d) => typeof d.system_id === "string" && d.system_id.endsWith(`-${t}`),
  );
  return hit && typeof hit.system_id === "string" ? hit.system_id : `vm-freepbx-${t}`;
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveFreepbxDeployments(cfg, flags) {
  const normalized = normalizeFreepbxConfig(cfg);
  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance, normalized.deployments);
  }
  const mapOne = (d) => {
    const hostname =
      typeof d.hostname === "string" && d.hostname.trim() ? d.hostname.trim() : undefined;
    return {
      systemId: String(d.system_id),
      system_id: String(d.system_id),
      mode: "proxmox-qemu",
      hostname,
      proxmox: isObject(d.proxmox) ? d.proxmox : null,
      configure: isObject(d.configure) ? d.configure : null,
      raw: d,
    };
  };
  if (!selectedId) return normalized.deployments.map(mapOne);
  const d = normalized.deployments.find((x) => x.system_id === selectedId);
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [mapOne(d)];
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listFreepbxDeploymentSummaries(cfg) {
  const normalized = normalizeFreepbxConfig(cfg);
  return normalized.deployments.map((d) => {
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const q = isObject(px.qemu) ? px.qemu : {};
    return {
      system_id: d.system_id,
      mode: "proxmox-qemu",
      host_id: typeof px.host_id === "string" ? px.host_id : null,
      vmid: Number(q.vmid) || null,
      ip: typeof q.ip === "string" ? q.ip : null,
      template_vmid: Number(q.template_vmid) || null,
    };
  });
}
