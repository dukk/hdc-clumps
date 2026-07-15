import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { gatewayBind, gatewayPort, openclawVersion } from "./openclaw-render.mjs";

const OPENCLAW_ROLE = "openclaw";
const OPENCLAW_QEMU_SYSTEM_ID = /^vm-openclaw-[a-z]+$/;

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
export function normalizeOpenclawConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("openclaw config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("openclaw config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  if (!raw.length) {
    throw new Error("deployments[] is empty — add at least one entry");
  }
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
    if (mode !== "proxmox-qemu") {
      throw new Error(`${sid}: only proxmox-qemu mode is supported in v1 (got ${JSON.stringify(mode)})`);
    }
    if (!OPENCLAW_QEMU_SYSTEM_ID.test(sid)) {
      throw new Error(
        `system_id ${JSON.stringify(sid)} must match vm-openclaw-<letter> for proxmox-qemu`,
      );
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) {
      throw new Error(`${sid}: proxmox.host_id required`);
    }
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error(`${sid}: proxmox.qemu.vmid must be a positive number`);
    }
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    if (!ip) {
      throw new Error(`${sid}: proxmox.qemu.ip required (static CIDR for cloud-init)`);
    }
    const templateVmid = typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid);
    if (!Number.isFinite(templateVmid) || templateVmid <= 0) {
      throw new Error(`${sid}: proxmox.qemu.template_vmid must be a positive number`);
    }
  }
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listOpenclawDeploymentSummaries(cfg) {
  const { deployments } = normalizeOpenclawConfig(cfg);
  return deployments.map((d) => {
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    const install = isObject(d.install) ? d.install : {};
    const oc = isObject(d.openclaw) ? d.openclaw : {};
    return {
      system_id: d.system_id,
      mode: typeof d.mode === "string" ? d.mode : "proxmox-qemu",
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      install_enabled: install.enabled !== false,
      openclaw_version: openclawVersion(oc),
      gateway_bind: gatewayBind(oc),
      gateway_port: gatewayPort(oc),
    };
  });
}

/**
 * @param {string | undefined} instance
 * @param {Record<string, unknown>[] | undefined} [deployments]
 */
export function instanceFlagToSystemId(instance, deployments) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (OPENCLAW_QEMU_SYSTEM_ID.test(t)) return t;
  if (Array.isArray(deployments) && deployments.length > 0) {
    const letter = t.length === 1 || /^[a-z]+$/.test(t) ? t : null;
    if (letter) {
      const hit = deployments.find(
        (d) =>
          typeof d.system_id === "string" &&
          OPENCLAW_QEMU_SYSTEM_ID.test(d.system_id) &&
          d.system_id.endsWith(`-${letter}`),
      );
      if (hit && typeof hit.system_id === "string") return hit.system_id;
    }
  }
  return vmSystemId(OPENCLAW_ROLE, t);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveOpenclawDeployments(cfg, flags, opts = {}) {
  const { deployments } = normalizeOpenclawConfig(cfg);
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

  const hit = deployments.find((x) => x.system_id === selectedId);
  if (!hit) {
    throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [finalizeDeployment(hit, skipInstallCli, opts.skipInstall)];
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 */
function finalizeDeployment(d, skipInstallCli, skipInstallOpt) {
  const install = isObject(d.install)
    ? { ...d.install }
    : { enabled: true, linux_user: "openclaw", node_version: "24", docker: true };
  if (skipInstallCli || skipInstallOpt === true) {
    install.enabled = false;
  }
  const openclaw = isObject(d.openclaw) ? structuredClone(d.openclaw) : {};
  return {
    systemId: String(d.system_id),
    mode: typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu",
    hostname:
      typeof d.hostname === "string" && d.hostname.trim() ? d.hostname.trim() : undefined,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    install,
    openclaw,
    raw: d,
  };
}
