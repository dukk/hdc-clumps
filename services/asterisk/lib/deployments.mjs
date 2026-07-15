import {
  deploymentSystemIdPattern,
  lxcSystemId,
  vmSystemId,
} from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  mergeAsteriskSettings,
  sipPort,
  twilioEnabled,
} from "./asterisk-render.mjs";

const ASTERISK_ROLE = "asterisk";
const ASTERISK_LXC_SYSTEM_ID = deploymentSystemIdPattern(ASTERISK_ROLE);
const ASTERISK_QEMU_SYSTEM_ID = /^vm-asterisk-[a-z]+$/;

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
export function normalizeAsteriskConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("asterisk config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("asterisk config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const globalAsterisk = isObject(cfg.asterisk) ? structuredClone(cfg.asterisk) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  return {
    schemaVersion: version >= 2 ? 2 : version,
    defaults,
    asterisk: globalAsterisk,
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
    if (!sid) throw new Error("each deployment needs system_id");
    const mode =
      typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";

    if (mode === "configure-only") {
      if (!ASTERISK_LXC_SYSTEM_ID.test(sid) && !ASTERISK_QEMU_SYSTEM_ID.test(sid)) {
        throw new Error(
          `system_id ${JSON.stringify(sid)} must match asterisk-<letter> or vm-asterisk-<letter>`,
        );
      }
    } else if (mode === "proxmox-qemu") {
      if (!ASTERISK_QEMU_SYSTEM_ID.test(sid)) {
        throw new Error(
          `system_id ${JSON.stringify(sid)} must match vm-asterisk-<letter> for proxmox-qemu`,
        );
      }
    } else if (!ASTERISK_LXC_SYSTEM_ID.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match asterisk-<letter> for LXC`);
    }

    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    if (mode === "proxmox-lxc" || mode === "proxmox-qemu") {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
      if (!hostId) {
        throw new Error(`${sid}: proxmox.host_id required for ${mode}`);
      }
      if (mode === "proxmox-lxc") {
        const lxc = isObject(px.lxc) ? px.lxc : {};
        const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
        if (!Number.isFinite(vmid) || vmid <= 0) {
          throw new Error(`${sid}: proxmox.lxc.vmid must be a positive number`);
        }
      }
    }

    if (mode === "configure-only") {
      const configure = isObject(d.configure) ? d.configure : {};
      const via = typeof configure.via === "string" ? configure.via.trim() : "ssh";
      if (via === "pct") {
        const px = isObject(d.proxmox) ? d.proxmox : {};
        const lxc = isObject(px.lxc) ? px.lxc : {};
        const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
        if (!Number.isFinite(vmid) || vmid <= 0) {
          throw new Error(`${sid}: configure-only via pct needs proxmox.lxc.vmid`);
        }
      } else {
        const ssh = isObject(configure.ssh) ? configure.ssh : {};
        const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
        if (!host) {
          throw new Error(`${sid}: configure-only needs configure.ssh.host`);
        }
      }
    }
  }
}

/**
 * @param {ReturnType<typeof normalizeAsteriskConfig>} normalized
 * @param {Record<string, unknown>} deployment
 */
export function asteriskSettingsForDeployment(normalized, deployment) {
  return mergeAsteriskSettings(normalized.asterisk, deployment);
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listAsteriskDeploymentSummaries(cfg) {
  const normalized = normalizeAsteriskConfig(cfg);
  return normalized.deployments.map((d) => {
    const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const qemu = isObject(px.qemu) ? px.qemu : {};
    const vmid =
      mode === "proxmox-qemu"
        ? typeof qemu.vmid === "number"
          ? qemu.vmid
          : Number(qemu.vmid)
        : typeof lxc.vmid === "number"
          ? lxc.vmid
          : Number(lxc.vmid);
    const settings = asteriskSettingsForDeployment(normalized, d);
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      sip_port: sipPort(settings),
      twilio_enabled: twilioEnabled(settings),
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
  if (ASTERISK_LXC_SYSTEM_ID.test(t) || ASTERISK_QEMU_SYSTEM_ID.test(t)) return t;
  if (Array.isArray(deployments) && deployments.length > 0) {
    const letter = t.length === 1 || /^[a-z]+$/.test(t) ? t : null;
    if (letter) {
      const qemu = deployments.find(
        (d) =>
          typeof d.system_id === "string" &&
          ASTERISK_QEMU_SYSTEM_ID.test(d.system_id) &&
          d.system_id.endsWith(`-${letter}`),
      );
      if (qemu && typeof qemu.system_id === "string") return qemu.system_id;
      const lxc = deployments.find(
        (d) =>
          typeof d.system_id === "string" &&
          ASTERISK_LXC_SYSTEM_ID.test(d.system_id) &&
          d.system_id.endsWith(`-${letter}`),
      );
      if (lxc && typeof lxc.system_id === "string") return lxc.system_id;
    }
  }
  if (ASTERISK_QEMU_SYSTEM_ID.test(vmSystemId(ASTERISK_ROLE, t))) {
    return vmSystemId(ASTERISK_ROLE, t);
  }
  return lxcSystemId(ASTERISK_ROLE, t);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveAsteriskDeployments(cfg, flags, opts = {}) {
  const normalized = normalizeAsteriskConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance, normalized.deployments);
  }

  const mapOne = (d) => finalizeDeployment(normalized, d, skipInstallCli, opts.skipInstall);

  if (normalized.deployments.length === 1) {
    const d = normalized.deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [mapOne(d)];
  }

  if (!selectedId) {
    return normalized.deployments.map(mapOne);
  }

  const d = normalized.deployments.find((x) => x.system_id === selectedId);
  if (!d) {
    throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [mapOne(d)];
}

/**
 * @param {ReturnType<typeof normalizeAsteriskConfig>} normalized
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 */
function finalizeDeployment(normalized, d, skipInstallCli, skipInstallOpt) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli || skipInstallOpt === true) {
    install.enabled = false;
  }
  const mode =
    typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";
  const hostname =
    typeof d.hostname === "string" && d.hostname.trim() ? d.hostname.trim() : undefined;
  return {
    systemId: String(d.system_id),
    mode,
    hostname,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    install,
    asterisk: asteriskSettingsForDeployment(normalized, d),
    raw: d,
  };
}
