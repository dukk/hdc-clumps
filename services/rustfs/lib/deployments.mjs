import { deploymentSystemIdPattern, lxcSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  consolePort,
  drivesPerNode,
  normalizeImage,
  parseConsolePublicUrl,
  parseS3PublicUrl,
  s3Port,
  unsafeBypassDiskCheck,
} from "./rustfs-render.mjs";

const RUSTFS_ROLE = "rustfs";
export const REQUIRED_NODE_COUNT = 4;

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
export function normalizeRustfsConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("rustfs config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("rustfs config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  if (!raw.length) {
    throw new Error("deployments[] is empty — add at least one entry");
  }
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const rustfs = isObject(cfg.rustfs) ? cfg.rustfs : {};
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments, rustfs };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  if (deployments.length !== REQUIRED_NODE_COUNT) {
    throw new Error(
      `rustfs MNMD cluster requires exactly ${REQUIRED_NODE_COUNT} deployments (found ${deployments.length})`,
    );
  }
  const ids = new Set();
  const vmids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!deploymentSystemIdPattern(RUSTFS_ROLE).test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match rustfs-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const mode = typeof d.mode === "string" ? d.mode.trim() : "";
    if (mode === "proxmox-lxc" || mode === "" || !mode) {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
      if (!hostId) {
        throw new Error(`${sid}: proxmox.host_id required for proxmox-lxc`);
      }
      const lxc = isObject(px.lxc) ? px.lxc : {};
      const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
      if (!Number.isFinite(vmid) || vmid <= 0) {
        throw new Error(`${sid}: proxmox.lxc.vmid must be a positive number`);
      }
      if (vmids.has(vmid)) throw new Error(`duplicate proxmox.lxc.vmid ${vmid}`);
      vmids.add(vmid);
    }
  }
}

/**
 * @param {Record<string, unknown>} rustfsGlobal
 * @param {Record<string, unknown>} deploymentRustfs
 */
export function mergeRustfsSettings(rustfsGlobal, deploymentRustfs) {
  const base = isObject(rustfsGlobal) ? structuredClone(rustfsGlobal) : {};
  if (isObject(deploymentRustfs)) {
    deepMerge(base, deploymentRustfs);
  }
  return base;
}

/**
 * @param {Record<string, unknown>} d
 * @param {Record<string, unknown>} globalRustfs
 */
export function peerHostnameFromDeployment(d, globalRustfs) {
  const cluster = isObject(d.cluster) ? d.cluster : {};
  const explicit =
    typeof cluster.peer_hostname === "string" && cluster.peer_hostname.trim()
      ? cluster.peer_hostname.trim()
      : "";
  if (explicit) return explicit;

  const px = isObject(d.proxmox) ? d.proxmox : {};
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const hostname =
    (typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
    (typeof d.system_id === "string" && d.system_id.trim()) ||
    "rustfs";

  const suffix =
    typeof globalRustfs.cluster_dns_suffix === "string" ? globalRustfs.cluster_dns_suffix.trim() : "";
  if (!suffix || hostname.includes(".")) return hostname;
  return `${hostname}${suffix.startsWith(".") ? suffix : `.${suffix}`}`;
}

/**
 * @param {Record<string, unknown>[]} deployments
 * @param {Record<string, unknown>} globalRustfs
 */
export function clusterPeersFromDeployments(deployments, globalRustfs) {
  const sorted = clusterSortDeployments(deployments);
  return sorted.map((d) => ({
    systemId: String(d.system_id),
    hostname: peerHostnameFromDeployment(d, globalRustfs),
  }));
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
export function clusterSortDeployments(deployments) {
  return [...deployments].sort((a, b) => String(a.system_id ?? "").localeCompare(String(b.system_id ?? "")));
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listRustfsDeploymentSummaries(cfg) {
  const { deployments, rustfs } = normalizeRustfsConfig(cfg);
  let s3Public = null;
  let consolePublic = null;
  try {
    const s3 = parseS3PublicUrl(rustfs);
    s3Public = s3 ? s3.origin.replace(/\/+$/, "") : null;
  } catch {
    s3Public = null;
  }
  try {
    const c = parseConsolePublicUrl(rustfs);
    consolePublic = c ? c.origin.replace(/\/+$/, "") : null;
  } catch {
    consolePublic = null;
  }

  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : "proxmox-lxc";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const install = isObject(d.install) ? d.install : {};
    const merged = mergeRustfsSettings(rustfs, isObject(d.rustfs) ? d.rustfs : {});
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      peer_hostname: peerHostnameFromDeployment(d, rustfs),
      install_enabled: install.enabled !== false,
      image: normalizeImage(merged),
      s3_port: s3Port(merged),
      console_port: consolePort(merged),
      drives_per_node: drivesPerNode(merged),
      s3_public_url: s3Public,
      console_public_url: consolePublic,
      unsafe_bypass_disk_check: unsafeBypassDiskCheck(merged),
    };
  });
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (deploymentSystemIdPattern(RUSTFS_ROLE).test(t)) return t;
  return lxcSystemId(RUSTFS_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 * @param {Record<string, unknown>} globalRustfs
 */
function finalizeDeployment(d, skipInstallCli, skipInstallOpt, globalRustfs) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli || skipInstallOpt === true) {
    install.enabled = false;
  }
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";
  return {
    systemId: String(d.system_id),
    mode,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    rustfs: mergeRustfsSettings(globalRustfs, isObject(d.rustfs) ? d.rustfs : {}),
    install,
    cluster: isObject(d.cluster) ? d.cluster : {},
  };
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function allRustfsDeployments(cfg) {
  const { deployments, rustfs } = normalizeRustfsConfig(cfg);
  return clusterSortDeployments(deployments).map((d) =>
    finalizeDeployment(d, false, false, rustfs),
  );
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveRustfsDeployments(cfg, flags, opts = {}) {
  const { deployments, rustfs } = normalizeRustfsConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance);
  }

  const sorted = clusterSortDeployments(deployments);

  if (!selectedId) {
    return sorted.map((d) => finalizeDeployment(d, skipInstallCli, opts.skipInstall, rustfs));
  }

  const d = sorted.find((x) => x.system_id === selectedId);
  if (!d) {
    throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [finalizeDeployment(d, skipInstallCli, opts.skipInstall, rustfs)];
}

/**
 * @param {ReturnType<typeof normalizeRustfsConfig>} normalized
 * @param {ReturnType<typeof resolveRustfsDeployments>} resolvedDeployments
 */
export function rustfsGlobalSettings(normalized, resolvedDeployments) {
  const global = isObject(normalized.rustfs) ? normalized.rustfs : {};
  const first = resolvedDeployments[0];
  const merged = first ? mergeRustfsSettings(global, first.rustfs) : global;
  return {
    image: normalizeImage(merged),
    s3Port: s3Port(merged),
    consolePort: consolePort(merged),
    drivesPerNode: drivesPerNode(merged),
    unsafeBypassDiskCheck: unsafeBypassDiskCheck(merged),
    accessKeyVaultKey:
      typeof merged.access_key_vault_key === "string" && merged.access_key_vault_key.trim()
        ? merged.access_key_vault_key.trim()
        : "HDC_RUSTFS_ACCESS_KEY",
    secretKeyVaultKey:
      typeof merged.secret_key_vault_key === "string" && merged.secret_key_vault_key.trim()
        ? merged.secret_key_vault_key.trim()
        : "HDC_RUSTFS_SECRET_KEY",
  };
}
