import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";

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
export function normalizeWindowsDesktopConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("windows-desktop config must be a JSON object");
  }
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("windows-desktop config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const windowsDesktop = isObject(cfg.windows_desktop)
    ? cfg.windows_desktop
    : isObject(defaults.windows_desktop)
      ? defaults.windows_desktop
      : {};
  return {
    schemaVersion: typeof cfg.schema_version === "number" ? cfg.schema_version : 1,
    defaults,
    deployments,
    windowsDesktop,
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
    if (!/^vm-win11-[a-z]+$/.test(sid) && !/^vm-windows-[a-z]+$/.test(sid)) {
      throw new Error(
        `system_id ${JSON.stringify(sid)} must match vm-win11-<letter> or vm-windows-<letter>`,
      );
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu-iso";
    if (mode !== "proxmox-qemu-iso" && mode !== "proxmox-qemu-clone") {
      throw new Error(`${sid}: mode must be proxmox-qemu-iso or proxmox-qemu-clone`);
    }
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) throw new Error(`${sid}: proxmox.host_id required`);
    const iso = isObject(px.iso) ? px.iso : isObject(d.iso) ? d.iso : {};
    const winIso =
      typeof iso.windows_volid === "string" ? iso.windows_volid.trim() : "";
    const virtioIso =
      typeof iso.virtio_volid === "string" ? iso.virtio_volid.trim() : "";
    if (mode === "proxmox-qemu-iso") {
      if (!winIso) throw new Error(`${sid}: proxmox.iso.windows_volid required`);
      if (!virtioIso) throw new Error(`${sid}: proxmox.iso.virtio_volid required`);
    }
  }
}

/**
 * @param {ReturnType<typeof normalizeWindowsDesktopConfig>} normalized
 */
export function resolveTemplateConfig(normalized) {
  const defaultsPx = isObject(normalized.defaults.proxmox) ? normalized.defaults.proxmox : {};
  const template = isObject(defaultsPx.template) ? defaultsPx.template : {};
  const hostId =
    (typeof template.host_id === "string" && template.host_id.trim()) ||
    (typeof defaultsPx.host_id === "string" && defaultsPx.host_id.trim()) ||
    "";
  const vmidRaw = template.vmid;
  const vmid =
    vmidRaw === null || vmidRaw === undefined || vmidRaw === ""
      ? 9001
      : Number(vmidRaw);
  if (!Number.isFinite(vmid) || vmid < 100) {
    throw new Error("defaults.proxmox.template.vmid must be a positive integer");
  }
  return {
    hostId,
    vmid,
    name:
      (typeof template.name === "string" && template.name.trim()) || "win11-template",
    builderHostname:
      (typeof template.builder_hostname === "string" && template.builder_hostname.trim()) ||
      "WIN11-BUILD",
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveWindowsDesktopDeployments(cfg, flags) {
  const normalized = normalizeWindowsDesktopConfig(cfg);
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
    const sid = vmSystemId("win11", letter);
    const one = all.find((d) => d.systemId === sid);
    if (!one) {
      const alt = vmSystemId("windows", letter);
      const altOne = all.find((d) => d.systemId === alt);
      if (!altOne) throw new Error(`no deployment for --instance ${JSON.stringify(instance)}`);
      return [altOne];
    }
    return [one];
  }
  return all;
}

/**
 * @param {Record<string, unknown>} entry
 * @param {ReturnType<typeof normalizeWindowsDesktopConfig>} normalized
 */
function expandDeployment(entry, normalized) {
  const systemId = String(entry.system_id ?? "").trim();
  const px = isObject(entry.proxmox) ? entry.proxmox : {};
  const defaultsPx = isObject(normalized.defaults.proxmox) ? normalized.defaults.proxmox : {};
  const q = { ...(isObject(defaultsPx.qemu) ? defaultsPx.qemu : {}), ...(isObject(px.qemu) ? px.qemu : {}) };
  const net = {
    ...(isObject(defaultsPx.network) ? defaultsPx.network : {}),
    ...(isObject(px.network) ? px.network : {}),
  };
  const iso = {
    ...(isObject(defaultsPx.iso) ? defaultsPx.iso : {}),
    ...(isObject(px.iso) ? px.iso : {}),
  };
  const oem = {
    ...(isObject(defaultsPx.oem) ? defaultsPx.oem : {}),
    ...(isObject(px.oem) ? px.oem : {}),
  };
  const template = {
    ...(isObject(defaultsPx.template) ? defaultsPx.template : {}),
    ...(isObject(px.template) ? px.template : {}),
  };

  const hostId =
    (typeof px.host_id === "string" && px.host_id.trim()) ||
    (typeof defaultsPx.host_id === "string" && defaultsPx.host_id.trim()) ||
    "";

  const vmidRaw = q.vmid;
  const vmid =
    vmidRaw === null || vmidRaw === undefined || vmidRaw === ""
      ? null
      : Number(vmidRaw);

  return {
    systemId,
    mode: typeof entry.mode === "string" ? entry.mode.trim() : "proxmox-qemu-iso",
    hostname:
      (typeof entry.hostname === "string" && entry.hostname.trim()) ||
      systemId.replace(/^vm-/, ""),
    proxmox: {
      hostId,
      qemu: q,
      network: net,
      iso,
      oem,
      template,
    },
    configure: isObject(entry.configure) ? entry.configure : {},
    windowsDesktop: normalized.windowsDesktop,
  };
}

/**
 * @param {string} systemId
 */
function instanceLetterFromSystemId(systemId) {
  const m = /^vm-(?:win11|windows)-([a-z]+)$/.exec(String(systemId ?? "").trim());
  return m ? m[1] : "";
}

/**
 * @param {string} systemId
 */
export function instanceLetterFromDeploymentId(systemId) {
  return instanceLetterFromSystemId(systemId);
}

/**
 * @param {ReturnType<typeof expandDeployment>} deployment
 */
export function adminVaultKey(deployment) {
  const wd = deployment.windowsDesktop;
  const key =
    typeof wd.admin_vault_key === "string" && wd.admin_vault_key.trim()
      ? wd.admin_vault_key.trim()
      : "HDC_WINDOWS_DESKTOP_ADMIN_PASSWORD";
  return key;
}

/**
 * @param {ReturnType<typeof expandDeployment>} deployment
 */
export function adminUsername(deployment) {
  const wd = deployment.windowsDesktop;
  return typeof wd.admin_username === "string" && wd.admin_username.trim()
    ? wd.admin_username.trim()
    : "Administrator";
}

/**
 * @param {ReturnType<typeof expandDeployment>} deployment
 */
export function localeId(deployment) {
  const wd = deployment.windowsDesktop;
  return typeof wd.locale === "string" && wd.locale.trim() ? wd.locale.trim() : "en-US";
}

/**
 * @param {string} volid e.g. local:iso/file.iso
 * @returns {{ storage: string; filename: string }}
 */
export function parseIsoVolid(volid) {
  const s = String(volid ?? "").trim();
  const colon = s.indexOf(":");
  if (colon < 0) throw new Error(`invalid ISO volid ${JSON.stringify(volid)} (expected storage:path)`);
  const storage = s.slice(0, colon).trim();
  const filename = s.slice(colon + 1).trim();
  if (!storage || !filename) throw new Error(`invalid ISO volid ${JSON.stringify(volid)}`);
  return { storage, filename };
}
