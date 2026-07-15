import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const KALI_ROLE = "kali";
const VM_ID_PATTERN = /^vm-kali-[a-z]+$/;

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
export function kaliDesktopBlock(cfg) {
  return isObject(cfg.kali_desktop) ? cfg.kali_desktop : {};
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeKaliDesktopConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("kali-desktop config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("kali-desktop config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  return { schemaVersion: version, defaults, deployments, kaliDesktop: kaliDesktopBlock(cfg) };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!VM_ID_PATTERN.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-kali-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
    if (mode !== "proxmox-qemu") {
      throw new Error(`${sid}: only proxmox-qemu mode is supported`);
    }
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) throw new Error(`${sid}: proxmox.host_id required`);
    const q = isObject(px.qemu) ? px.qemu : {};
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    if (!ip || !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(ip)) {
      throw new Error(`${sid}: proxmox.qemu.ip must be CIDR (e.g. 192.0.2.189/24)`);
    }
    const templateVmid = typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid);
    if (!Number.isFinite(templateVmid) || templateVmid <= 0) {
      const defPx = isObject(d.proxmox) ? d.proxmox : {};
      const defQ = isObject(defPx.qemu) ? defPx.qemu : {};
      const fromDef = typeof defQ.template_vmid === "number" ? defQ.template_vmid : Number(defQ.template_vmid);
      if (!Number.isFinite(fromDef) || fromDef <= 0) {
        throw new Error(`${sid}: proxmox.qemu.template_vmid required (defaults or deployment)`);
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listKaliDesktopDeploymentSummaries(cfg) {
  const { deployments } = normalizeKaliDesktopConfig(cfg);
  return deployments.map((d) => {
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = q.vmid === null || q.vmid === undefined ? null : Number(q.vmid);
    const configure = isObject(d.configure) ? d.configure : {};
    const ssh = isObject(configure.ssh) ? configure.ssh : {};
    return {
      system_id: d.system_id,
      mode: "proxmox-qemu",
      host_id: hostId,
      hostname: typeof d.hostname === "string" ? d.hostname : null,
      vmid: Number.isFinite(vmid) ? vmid : null,
      ip: typeof q.ip === "string" ? q.ip : null,
      template_vmid: typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid) || null,
      ssh_host: typeof ssh.host === "string" ? ssh.host : null,
      ssh_user: typeof ssh.user === "string" ? ssh.user : "kali",
    };
  });
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (VM_ID_PATTERN.test(t)) return t;
  return vmSystemId(KALI_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 * @param {Record<string, unknown>} kaliDesktop
 */
function finalizeDeployment(d, kaliDesktop) {
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-qemu";
  return {
    systemId: String(d.system_id),
    mode,
    hostname: typeof d.hostname === "string" && d.hostname.trim() ? d.hostname.trim() : null,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : {},
    kaliDesktop,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveKaliDesktopDeployments(cfg, flags) {
  const { deployments, kaliDesktop } = normalizeKaliDesktopConfig(cfg);

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
    return [finalizeDeployment(d, kaliDesktop)];
  }

  if (!selectedId) {
    return deployments.map((d) => finalizeDeployment(d, kaliDesktop));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) {
    throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [finalizeDeployment(d, kaliDesktop)];
}

/**
 * Merge defaults.proxmox into deployment proxmox for deploy helpers.
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown> | null} proxmox
 */
export function mergedProxmoxBlock(defaults, proxmox) {
  const defPx = isObject(defaults.proxmox) ? structuredClone(defaults.proxmox) : {};
  const depPx = isObject(proxmox) ? proxmox : {};
  return deepMerge(defPx, depPx);
}
