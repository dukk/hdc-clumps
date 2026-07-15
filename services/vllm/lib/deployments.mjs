import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  hostPort,
  normalizeInstallDevice,
  parsePublicUrl,
} from "./vllm-render.mjs";

const VLLM_ROLE = "vllm";
const VLLM_QEMU_SYSTEM_ID = /^vm-vllm-[a-z]+$/;

/** @type {readonly string[]} */
export const INSTALL_DEVICES = ["cuda", "cpu"];

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
export function normalizeVllmConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("vllm config must be a JSON object");
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
  throw new Error("vllm config needs deployments[]");
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!VLLM_QEMU_SYSTEM_ID.test(sid)) {
      throw new Error(
        `system_id ${JSON.stringify(sid)} must match vm-vllm-<letter> for proxmox-qemu`,
      );
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
    if (mode !== "proxmox-qemu") {
      throw new Error(`${sid}: mode must be proxmox-qemu (got ${JSON.stringify(mode)})`);
    }

    const install = isObject(d.install) ? d.install : {};
    normalizeInstallDevice(typeof install.device === "string" ? install.device : "cuda");

    const vllm = isObject(d.vllm) ? d.vllm : {};
    const model = typeof vllm.model === "string" ? vllm.model.trim() : "";
    if (!model) {
      throw new Error(`${sid}: vllm.model is required (non-empty Hugging Face model id)`);
    }
    const publicUrl = typeof vllm.public_url === "string" ? vllm.public_url.trim() : "";
    if (publicUrl) parsePublicUrl(vllm);

    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) {
      throw new Error(`${sid}: proxmox.host_id required for proxmox-qemu`);
    }
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    const templateVmid =
      typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid);
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error(`${sid}: proxmox.qemu.vmid must be a positive number`);
    }
    if (!Number.isFinite(templateVmid) || templateVmid <= 0) {
      throw new Error(`${sid}: proxmox.qemu.template_vmid must be a positive number`);
    }
    if (!ip) {
      throw new Error(`${sid}: proxmox.qemu.ip required for proxmox-qemu`);
    }
  }
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listVllmDeploymentSummaries(cfg) {
  const { deployments } = normalizeVllmConfig(cfg);
  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : "proxmox-qemu";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const qemu = isObject(px.qemu) ? px.qemu : {};
    const qemuVmid = typeof qemu.vmid === "number" ? qemu.vmid : Number(qemu.vmid);
    const install = isObject(d.install) ? d.install : {};
    const vllm = isObject(d.vllm) ? d.vllm : {};
    let publicUrl = null;
    try {
      const parsed = parsePublicUrl(vllm);
      publicUrl = parsed ? parsed.origin.replace(/\/+$/, "") : null;
    } catch {
      publicUrl = null;
    }
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(qemuVmid) ? qemuVmid : null,
      install_enabled: install.enabled !== false,
      install_device: normalizeInstallDevice(
        typeof install.device === "string" ? install.device : "cuda",
      ),
      port: hostPort(vllm),
      model: typeof vllm.model === "string" ? vllm.model.trim() : null,
      public_url: publicUrl,
    };
  });
}

/**
 * Resolve instance flag to a system id (`a` → `vm-vllm-a`).
 * @param {string | undefined} instance
 * @param {Record<string, unknown>[] | undefined} [deployments]
 */
export function instanceFlagToSystemId(instance, deployments) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (VLLM_QEMU_SYSTEM_ID.test(t)) return t;
  if (Array.isArray(deployments) && deployments.length > 0) {
    const letter = t.length === 1 || /^[a-z]+$/.test(t) ? t : null;
    if (letter) {
      const qemu = deployments.find(
        (d) =>
          typeof d.system_id === "string" &&
          VLLM_QEMU_SYSTEM_ID.test(d.system_id) &&
          d.system_id.endsWith(`-${letter}`),
      );
      if (qemu && typeof qemu.system_id === "string") return qemu.system_id;
    }
  }
  return vmSystemId(VLLM_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 */
function finalizeDeployment(d, skipInstallCli, skipInstallOpt) {
  const installRaw = isObject(d.install) ? { ...d.install } : { enabled: true, device: "cuda" };
  const install = {
    ...installRaw,
    device: normalizeInstallDevice(
      typeof installRaw.device === "string" ? installRaw.device : "cuda",
    ),
  };
  if (skipInstallCli || skipInstallOpt === true) {
    install.enabled = false;
  }
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-qemu";
  const hostname =
    typeof d.hostname === "string" && d.hostname.trim() ? d.hostname.trim() : undefined;
  return {
    systemId: String(d.system_id),
    mode,
    hostname,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    install,
    vllm: isObject(d.vllm) ? d.vllm : {},
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveVllmDeployments(cfg, flags, opts = {}) {
  const { deployments } = normalizeVllmConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance, deployments);
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
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveVllmDeployment(cfg, flags, opts = {}) {
  const list = resolveVllmDeployments(cfg, flags, opts);
  return list[0];
}
