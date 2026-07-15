import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { normalizeUsbList } from "../../../infrastructure/proxmox/lib/proxmox-qemu-usb.mjs";

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
export function normalizeHomeassistantConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("homeassistant config must be a JSON object");
  }
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("homeassistant config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const ha = isObject(cfg.homeassistant)
    ? cfg.homeassistant
    : isObject(defaults.homeassistant)
      ? defaults.homeassistant
      : {};
  return {
    schemaVersion: typeof cfg.schema_version === "number" ? cfg.schema_version : 1,
    defaults,
    deployments,
    homeassistant: ha,
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
    if (!/^vm-homeassistant-[a-z]+$/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-homeassistant-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu-haos";
    if (mode !== "proxmox-qemu-haos") {
      throw new Error(`${sid}: mode must be proxmox-qemu-haos`);
    }
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) throw new Error(`${sid}: proxmox.host_id required`);
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error(`${sid}: proxmox.qemu.vmid must be a positive number`);
    }
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    if (!ip) throw new Error(`${sid}: proxmox.qemu.ip required (e.g. 192.0.2.30/24)`);
    const ha = isObject(d.homeassistant) ? d.homeassistant : {};
    const release =
      typeof ha.release === "string" && ha.release.trim()
        ? ha.release.trim()
        : "";
    if (!release) throw new Error(`${sid}: homeassistant.release required (e.g. 16.0)`);
  }
}

/**
 * @param {Record<string, unknown>} d
 * @param {ReturnType<typeof normalizeHomeassistantConfig>} normalized
 */
export function expandDeployment(d, normalized) {
  const px = isObject(d.proxmox) ? d.proxmox : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const net = isObject(px.network) ? px.network : isObject(d.network) ? d.network : {};
  const defPx = isObject(normalized.defaults.proxmox) ? normalized.defaults.proxmox : {};
  const defQ = isObject(defPx.qemu) ? defPx.qemu : {};
  const defNet = isObject(defPx.network) ? defPx.network : isObject(normalized.defaults.network) ? normalized.defaults.network : {};
  const ha = isObject(d.homeassistant)
    ? d.homeassistant
    : isObject(normalized.homeassistant)
      ? normalized.homeassistant
      : {};

  const systemId = String(d.system_id).trim();
  const hostname =
    typeof d.hostname === "string" && d.hostname.trim()
      ? d.hostname.trim()
      : typeof q.name === "string" && q.name.trim()
        ? q.name.trim()
        : "ha";

  const release = typeof ha.release === "string" ? ha.release.trim() : "";
  const publicUrl = typeof ha.public_url === "string" ? ha.public_url.trim() : "";
  const trustedProxies = Array.isArray(ha.trusted_proxies)
    ? ha.trusted_proxies.map((v) => String(v).trim()).filter(Boolean)
    : [];

  const gateway =
    typeof net.gateway === "string" && net.gateway.trim()
      ? net.gateway.trim()
      : typeof defNet.gateway === "string"
        ? defNet.gateway.trim()
        : "";
  const dns = Array.isArray(net.dns)
    ? net.dns.map(String)
    : Array.isArray(defNet.dns)
      ? defNet.dns.map(String)
      : [];

  const usbRaw = Array.isArray(q.usb) ? q.usb : [];
  const usb = normalizeUsbList(usbRaw);

  return {
    systemId,
    mode: "proxmox-qemu-haos",
    hostname,
    homeassistant: { release, publicUrl, trustedProxies },
    proxmox: {
      hostId: String(px.host_id).trim(),
      qemu: {
        vmid: Number(q.vmid),
        name: typeof q.name === "string" && q.name.trim() ? q.name.trim() : hostname,
        ip: String(q.ip).trim(),
        cores: Number(q.cores ?? defQ.cores) || 2,
        memoryMb: Number(q.memory_mb ?? defQ.memory_mb) || 4096,
        rootfsGb: Number(q.rootfs_gb ?? defQ.rootfs_gb) || 32,
        storage: typeof q.storage === "string" ? q.storage.trim() : String(defQ.storage ?? "local-lvm").trim(),
        imageStorage:
          typeof q.image_storage === "string"
            ? q.image_storage.trim()
            : String(defQ.image_storage ?? "local").trim(),
        bridge: typeof q.bridge === "string" ? q.bridge.trim() : String(defQ.bridge ?? "vmbr0").trim(),
        usb,
      },
      network: { gateway, dns, bridge: typeof net.bridge === "string" ? net.bridge.trim() : "" },
    },
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveHomeassistantDeployments(cfg, flags) {
  const normalized = normalizeHomeassistantConfig(cfg);
  const all = normalized.deployments.map((d) => expandDeployment(d, normalized));
  const systemId = flagGet(flags, "system-id");
  const instance = flagGet(flags, "instance");
  if (systemId) {
    const one = all.find((d) => d.systemId === systemId.trim());
    if (!one) throw new Error(`no deployment for system_id ${JSON.stringify(systemId)}`);
    return [one];
  }
  if (instance) {
    const letter = instance.trim().toLowerCase();
    const sid = vmSystemId("homeassistant", letter);
    const one = all.find((d) => d.systemId === sid);
    if (!one) throw new Error(`no deployment for instance ${JSON.stringify(instance)} (${sid})`);
    return [one];
  }
  return all;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listHomeassistantDeploymentSummaries(cfg) {
  try {
    const normalized = normalizeHomeassistantConfig(cfg);
    return normalized.deployments.map((d) => {
      const e = expandDeployment(d, normalized);
      return {
        system_id: e.systemId,
        host_id: e.proxmox.hostId,
        vmid: e.proxmox.qemu.vmid,
        ip: e.proxmox.qemu.ip,
        release: e.homeassistant.release,
        usb_count: e.proxmox.qemu.usb.length,
      };
    });
  } catch {
    return [];
  }
}
