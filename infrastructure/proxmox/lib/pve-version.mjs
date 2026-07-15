import { isProxmoxConfigObject } from "./proxmox-config.mjs";
import { pveData, pveJsonRequest } from "./pve-http.mjs";

/** Keys allowed on PUT /storage/{id} (Proxmox updateSchema on PVE 8 and 9). */
export const STORAGE_UPDATE_KEYS = new Set([
  "nodes",
  "content",
  "options",
  "disable",
  "prune-backups",
  "max-protected-backups",
  "content-dirs",
  "format",
  "preallocation",
  "bwlimit",
  "mkdir",
  "create-base-path",
  "create-subdirs",
  "username",
  "password",
  "domain",
  "smbversion",
  "subdir",
]);

/** Base API token privileges for hdc maintain on PVE 8.x (includes VM.Monitor). */
export const HDC_PROXMOX_API_PRIVILEGES_PVE8 = [
  "Datastore.Allocate",
  "Datastore.AllocateSpace",
  "Datastore.Audit",
  "VM.Allocate",
  "VM.Audit",
  "VM.Clone",
  "VM.Config.CDROM",
  "VM.Config.CPU",
  "VM.Config.Disk",
  "VM.Config.Memory",
  "VM.Config.Network",
  "VM.Config.Options",
  "VM.Backup",
  "VM.Replicate",
  "VM.Monitor",
  "VM.PowerMgmt",
  "Mapping.Modify",
  "Sys.Modify",
];

/** PVE 9.x: VM.Monitor removed; Sys.AccessNetwork required for download-url. */
export const HDC_PROXMOX_API_PRIVILEGES_PVE9 = [
  ...HDC_PROXMOX_API_PRIVILEGES_PVE8.filter((p) => p !== "VM.Monitor"),
  "Sys.AccessNetwork",
];

/** @deprecated Use HDC_PROXMOX_API_PRIVILEGES_PVE8 */
export const HDC_PROXMOX_API_PRIVILEGES = HDC_PROXMOX_API_PRIVILEGES_PVE8;

/** @typedef {object} PveVersionInfo
 * @property {number} major 8 or 9
 * @property {string} release e.g. "8.4"
 * @property {string} version e.g. "8.4.19"
 * @property {string} [repoid]
 */

/** @typedef {object} PveProfile
 * @property {number} major
 * @property {string} id "pve8" | "pve9"
 * @property {Set<string>} storageUpdateKeys
 * @property {string[]} apiTokenPrivileges
 * @property {"aplinfo" | "download-url"} lxcTemplateDownload
 */

/**
 * @param {unknown} body
 * @returns {PveVersionInfo | null}
 */
export function parsePveVersionBody(body) {
  const row = pveData(body);
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const rec = /** @type {Record<string, unknown>} */ (row);
  const release = typeof rec.release === "string" ? rec.release.trim() : "";
  const version = typeof rec.version === "string" ? rec.version.trim() : "";
  const repoid = typeof rec.repoid === "string" ? rec.repoid.trim() : undefined;
  const major = pveMajorFromRelease(release || version);
  if (major === null) return null;
  return {
    major,
    release: release || String(major),
    version: version || release || String(major),
    repoid,
  };
}

/**
 * @param {string} releaseOrVersion
 * @returns {8 | 9 | null}
 */
export function pveMajorFromRelease(releaseOrVersion) {
  const s = String(releaseOrVersion ?? "").trim();
  const m = s.match(/^(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n === 8 || n === 9) return n;
  return null;
}

/**
 * @param {string} cliOutput stdout from `pve version`
 * @returns {PveVersionInfo | null}
 */
export function parsePveVersionFromCli(cliOutput) {
  const text = String(cliOutput ?? "");
  const m = text.match(/pve-manager\/(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number(m[1]);
  if (major !== 8 && major !== 9) return null;
  const minor = m[2];
  const release = `${major}.${minor}`;
  return {
    major,
    release,
    version: release,
  };
}

/**
 * @param {8 | 9 | number} major
 * @returns {PveProfile}
 */
export function pveProfileForMajor(major) {
  const m = major === 9 ? 9 : 8;
  if (m === 9) {
    return {
      major: 9,
      id: "pve9",
      storageUpdateKeys: STORAGE_UPDATE_KEYS,
      apiTokenPrivileges: [...HDC_PROXMOX_API_PRIVILEGES_PVE9],
      lxcTemplateDownload: "aplinfo",
    };
  }
  return {
    major: 8,
    id: "pve8",
    storageUpdateKeys: STORAGE_UPDATE_KEYS,
    apiTokenPrivileges: [...HDC_PROXMOX_API_PRIVILEGES_PVE8],
    lxcTemplateDownload: "aplinfo",
  };
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<PveVersionInfo | null>}
 */
export async function fetchPveVersion(apiBase, authorization, rejectUnauthorized) {
  try {
    const body = await pveJsonRequest(
      "GET",
      apiBase,
      "/version",
      authorization,
      rejectUnauthorized,
      undefined,
    );
    return parsePveVersionBody(body);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} configCluster clusters[] entry from config.json
 * @returns {PveVersionInfo | null}
 */
export function pveVersionFromConfigCluster(configCluster) {
  if (!isProxmoxConfigObject(configCluster)) return null;
  const rel = configCluster.pve_release;
  if (typeof rel !== "string" || !rel.trim()) return null;
  const major = pveMajorFromRelease(rel.trim());
  if (major === null) return null;
  return {
    major,
    release: rel.trim(),
    version: rel.trim(),
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.apiBase]
 * @param {string} [opts.authorization]
 * @param {boolean} [opts.rejectUnauthorized]
 * @param {unknown} [opts.configCluster]
 * @param {string} [opts.cliVersionOutput] `pve version` stdout for SSH fallback
 * @returns {Promise<{ version: PveVersionInfo; profile: PveProfile } | null>}
 */
export async function resolveClusterPveProfile(opts) {
  const { apiBase, authorization, rejectUnauthorized, configCluster, cliVersionOutput } = opts;

  /** @type {PveVersionInfo | null} */
  let version = null;

  if (apiBase && authorization && typeof rejectUnauthorized === "boolean") {
    version = await fetchPveVersion(apiBase, authorization, rejectUnauthorized);
  }

  if (!version && cliVersionOutput) {
    version = parsePveVersionFromCli(cliVersionOutput);
  }

  if (!version && configCluster) {
    version = pveVersionFromConfigCluster(configCluster);
  }

  if (!version) return null;

  return { version, profile: pveProfileForMajor(version.major) };
}

/**
 * @param {PveVersionInfo} version
 * @param {PveProfile} profile
 */
export function formatPveVersionLog(version, profile) {
  return `release ${version.release} (profile ${profile.id})`;
}
