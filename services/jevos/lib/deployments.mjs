import { deploymentSystemIdPattern, lxcSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const JEVOS_ROLE = "jevos";
const JEVOS_SYSTEM_ID = deploymentSystemIdPattern(JEVOS_ROLE);

/** jev + OpenVINO libs (~0.1 GB) + INT8 model (~0.7 GB unpacked) + zip cache. */
export const MIN_JEVOS_ROOTFS_GB = 4;
/** jev serve uses ~1-1.4 GB RSS. */
export const MIN_JEVOS_MEMORY_MB = 2048;
export const DEFAULT_JEVOS_PORT = 8017;
export const DEFAULT_JEVOS_API_KEY_VAULT_KEY = "HDC_JEVOS_API_KEY";

export const DEFAULT_JEVOS_INSTALL = Object.freeze({
  enabled: true,
  repo: "feder-cr/jev",
  release: "jevos-v4",
  binary_asset: "jev-linux-x64.tar.gz",
  model_asset: "jevos-v4-openvino-int8.zip",
});

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

/** @param {unknown} v */
function num(v) {
  return typeof v === "number" ? v : Number(v);
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeJevosConfig(cfg) {
  if (!isObject(cfg)) throw new Error("jevos config must be a JSON object");
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("jevos config needs deployments[] (schema_version 2)");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const deployments = cfg.deployments.filter(isObject).map((entry) => {
    const base = structuredClone(defaults);
    deepMerge(base, entry);
    return base;
  });
  validateDeployments(deployments);
  return { schemaVersion: 2, defaults, deployments };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!JEVOS_SYSTEM_ID.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match jevos-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const mode = typeof d.mode === "string" ? d.mode.trim() : "";
    if (mode !== "proxmox-lxc") {
      throw new Error(`${sid}: mode must be proxmox-lxc (got ${JSON.stringify(mode)})`);
    }
    const px = isObject(d.proxmox) ? d.proxmox : {};
    if (typeof px.host_id !== "string" || !px.host_id.trim()) {
      throw new Error(`${sid}: proxmox.host_id required`);
    }
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = num(lxc.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error(`${sid}: proxmox.lxc.vmid must be a positive number`);
    }
    const rootfs = num(lxc.rootfs_gb);
    if (!Number.isFinite(rootfs) || rootfs < MIN_JEVOS_ROOTFS_GB) {
      throw new Error(`${sid}: proxmox.lxc.rootfs_gb must be >= ${MIN_JEVOS_ROOTFS_GB}`);
    }
    const mem = num(lxc.memory_mb);
    if (!Number.isFinite(mem) || mem < MIN_JEVOS_MEMORY_MB) {
      throw new Error(`${sid}: proxmox.lxc.memory_mb must be >= ${MIN_JEVOS_MEMORY_MB}`);
    }
    const server = isObject(d.server) ? d.server : {};
    if (server.port !== undefined) {
      const port = num(server.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`${sid}: server.port must be 1-65535`);
      }
    }
  }
}

/**
 * Guest IPv4 (no prefix) from proxmox.lxc.ip_config (`10.0.0.23/24,gw=...`); null for dhcp.
 * @param {Record<string, unknown> | null | undefined} lxc
 */
export function guestIpFromLxc(lxc) {
  const raw = isObject(lxc) && typeof lxc.ip_config === "string" ? lxc.ip_config.trim() : "";
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?/.exec(raw);
  return m ? m[1] : null;
}

/**
 * @param {Record<string, unknown>} server
 */
export function serverPort(server) {
  const p = isObject(server) ? num(server.port) : NaN;
  return Number.isInteger(p) && p > 0 ? p : DEFAULT_JEVOS_PORT;
}

/**
 * @param {Record<string, unknown>} server
 */
export function apiKeyVaultKey(server) {
  const k = isObject(server) && typeof server.api_key_vault_key === "string" ? server.api_key_vault_key.trim() : "";
  return k || DEFAULT_JEVOS_API_KEY_VAULT_KEY;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listJevosDeploymentSummaries(cfg) {
  return normalizeJevosConfig(cfg).deployments.map((d) => {
    const px = /** @type {Record<string, any>} */ (d.proxmox);
    const server = isObject(d.server) ? d.server : {};
    const install = isObject(d.install) ? d.install : {};
    return {
      system_id: d.system_id,
      mode: d.mode,
      host_id: px.host_id,
      vmid: num(px.lxc?.vmid),
      ip: guestIpFromLxc(px.lxc),
      port: serverPort(server),
      release: typeof install.release === "string" ? install.release : DEFAULT_JEVOS_INSTALL.release,
      install_enabled: install.enabled !== false,
      api_key_vault_key: apiKeyVaultKey(server),
    };
  });
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (JEVOS_SYSTEM_ID.test(t)) return t;
  return lxcSystemId(JEVOS_ROLE, t);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveJevosDeployments(cfg, flags) {
  const { deployments } = normalizeJevosConfig(cfg);
  const skipInstall = flags["skip-install"] !== undefined;
  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) selectedId = instanceFlagToSystemId(instance);
  const picked = selectedId ? deployments.filter((d) => d.system_id === selectedId) : deployments;
  if (selectedId && !picked.length) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return picked.map((d) => {
    const install = { ...DEFAULT_JEVOS_INSTALL, ...(isObject(d.install) ? d.install : {}) };
    if (skipInstall) install.enabled = false;
    return {
      systemId: String(d.system_id),
      mode: String(d.mode),
      proxmox: /** @type {Record<string, any>} */ (d.proxmox),
      install,
      server: isObject(d.server) ? d.server : {},
    };
  });
}
