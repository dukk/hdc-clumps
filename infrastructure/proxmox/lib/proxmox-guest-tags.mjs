import { pveFormBody, pveJsonRequest } from "./pve-http.mjs";
import { getLxcConfig, getQemuConfig } from "./proxmox-guest-resources.mjs";

const PACKAGE_TAG_RE = /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/;

/** Mutually exclusive Proxmox guest tags for backup frequency. */
export const BACKUP_FREQUENCY_TAGS = Object.freeze([
  "backup-hourly",
  "backup-daily",
  "backup-weekly",
  "backup-twice-weekly",
]);

/** @type {Readonly<Record<string, string>>} */
export const BACKUP_PROFILE_TO_TAG = Object.freeze({
  hourly: "backup-hourly",
  daily: "backup-daily",
  weekly: "backup-weekly",
  "twice-weekly": "backup-twice-weekly",
});

/** @type {Readonly<Record<string, string>>} */
export const BACKUP_TAG_TO_PROFILE = Object.freeze({
  "backup-hourly": "hourly",
  "backup-daily": "daily",
  "backup-weekly": "weekly",
  "backup-twice-weekly": "twice-weekly",
});

/**
 * @param {unknown} profile
 * @returns {string | null}
 */
export function backupFrequencyTagForProfile(profile) {
  if (typeof profile !== "string") return null;
  const tag = BACKUP_PROFILE_TO_TAG[profile.trim()];
  return tag || null;
}

/**
 * @param {string[]} tags
 * @returns {string | null}
 */
export function liveBackupFrequencyTag(tags) {
  for (const t of tags) {
    if (BACKUP_FREQUENCY_TAGS.includes(t)) return t;
  }
  return null;
}

/**
 * Ensure exactly one backup frequency tag matching `profile`.
 * Removes other frequency tags; preserves package and unrelated tags.
 *
 * @param {unknown} existing
 * @param {unknown} profile
 * @returns {{ tags: string[]; changed: boolean; desiredTag: string | null }}
 */
export function mergeBackupFrequencyTag(existing, profile) {
  const desiredTag = backupFrequencyTagForProfile(profile);
  const current = parseProxmoxTags(existing);
  if (!desiredTag) {
    return { tags: current, changed: false, desiredTag: null };
  }
  const withoutFreq = current.filter((t) => !BACKUP_FREQUENCY_TAGS.includes(t));
  const next = [...withoutFreq, desiredTag];
  const live = liveBackupFrequencyTag(current);
  const freqCount = current.filter((t) => BACKUP_FREQUENCY_TAGS.includes(t)).length;
  const changed = live !== desiredTag || freqCount !== 1;
  return { tags: next, changed, desiredTag };
}

/**
 * @param {unknown} mode
 * @returns {"lxc"|"qemu"|null}
 */
export function proxmoxGuestTypeFromMode(mode) {
  if (mode === "proxmox-lxc") return "lxc";
  if (
    mode === "proxmox-qemu" ||
    mode === "proxmox-qemu-clone" ||
    mode === "proxmox-qemu-iso" ||
    mode === "proxmox-qemu-haos"
  ) {
    return "qemu";
  }
  return null;
}

/**
 * @param {unknown} clumpId
 * @returns {string | null}
 */
export function normalizePackageTag(clumpId) {
  if (typeof clumpId !== "string") return null;
  const tag = clumpId.trim().toLowerCase();
  if (!tag || !PACKAGE_TAG_RE.test(tag)) return null;
  return tag;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseProxmoxTags(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const parts = raw.split(/[;,]/);
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const part of parts) {
    const tag = part.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * @param {string[]} tags
 * @returns {string}
 */
export function formatProxmoxTags(tags) {
  const normalized = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const tag of tags) {
    const t = typeof tag === "string" ? tag.trim().toLowerCase() : "";
    if (!t || seen.has(t)) continue;
    seen.add(t);
    normalized.push(t);
  }
  return normalized.join(";");
}

/**
 * @param {unknown} existing
 * @param {unknown} clumpId
 * @returns {{ tags: string[]; changed: boolean }}
 */
export function mergePackageTag(existing, clumpId) {
  const tag = normalizePackageTag(clumpId);
  if (!tag) {
    return { tags: parseProxmoxTags(existing), changed: false };
  }
  const current = parseProxmoxTags(existing);
  if (current.includes(tag)) {
    return { tags: current, changed: false };
  }
  return { tags: [...current, tag], changed: true };
}

/**
 * @param {object} opts
 * @param {"lxc"|"qemu"} opts.guestType
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.clumpId
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureGuestPackageTag(opts) {
  const { guestType, apiBase, authorization, rejectUnauthorized, node, vmid, clumpId } = opts;
  const log = opts.log ?? (() => {});
  const tag = normalizePackageTag(clumpId);
  if (!tag) {
    return { ok: false, changed: false, message: `invalid package tag ${JSON.stringify(clumpId)}` };
  }

  const statusOpts = { apiBase, authorization, rejectUnauthorized, node, vmid };
  const cfg =
    guestType === "lxc" ? await getLxcConfig(statusOpts) : await getQemuConfig(statusOpts);
  const existing = typeof cfg.tags === "string" ? cfg.tags : "";
  const merged = mergePackageTag(existing, tag);

  if (!merged.changed) {
    log(`${guestType.toUpperCase()} ${vmid}: tag ${JSON.stringify(tag)} already present — skipping.`);
    return {
      ok: true,
      changed: false,
      applied: { tags: formatProxmoxTags(merged.tags) },
      previous: { tags: existing },
    };
  }

  const nextTags = formatProxmoxTags(merged.tags);
  const configPath = `/nodes/${encodeURIComponent(node)}/${guestType}/${encodeURIComponent(String(vmid))}/config`;
  log(
    `${guestType.toUpperCase()} ${vmid}: adding tag ${JSON.stringify(tag)} (was ${JSON.stringify(existing) || "(none)"}) …`,
  );
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({ tags: nextTags }),
  );
  log(`${guestType.toUpperCase()} ${vmid}: tags set to ${JSON.stringify(nextTags)}.`);
  return {
    ok: true,
    changed: true,
    applied: { tags: nextTags },
    previous: { tags: existing },
  };
}

/**
 * @param {object} opts
 * @param {"lxc"|"qemu"} opts.guestType
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.profile
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureGuestBackupFrequencyTag(opts) {
  const { guestType, apiBase, authorization, rejectUnauthorized, node, vmid, profile } = opts;
  const log = opts.log ?? (() => {});
  const desiredTag = backupFrequencyTagForProfile(profile);
  if (!desiredTag) {
    return {
      ok: false,
      changed: false,
      message: `unknown backup profile ${JSON.stringify(profile)}`,
      desiredTag: null,
    };
  }

  const statusOpts = { apiBase, authorization, rejectUnauthorized, node, vmid };
  const cfg =
    guestType === "lxc" ? await getLxcConfig(statusOpts) : await getQemuConfig(statusOpts);
  const existing = typeof cfg.tags === "string" ? cfg.tags : "";
  const merged = mergeBackupFrequencyTag(existing, profile);

  if (!merged.changed) {
    log(
      `${guestType.toUpperCase()} ${vmid}: frequency tag ${JSON.stringify(desiredTag)} already present — skipping.`,
    );
    return {
      ok: true,
      changed: false,
      desiredTag,
      liveTag: desiredTag,
      applied: { tags: formatProxmoxTags(merged.tags) },
      previous: { tags: existing },
    };
  }

  const nextTags = formatProxmoxTags(merged.tags);
  const configPath = `/nodes/${encodeURIComponent(node)}/${guestType}/${encodeURIComponent(String(vmid))}/config`;
  log(
    `${guestType.toUpperCase()} ${vmid}: set frequency tag ${JSON.stringify(desiredTag)} (was ${JSON.stringify(existing) || "(none)"}) …`,
  );
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({ tags: nextTags }),
  );
  log(`${guestType.toUpperCase()} ${vmid}: tags set to ${JSON.stringify(nextTags)}.`);
  return {
    ok: true,
    changed: true,
    desiredTag,
    liveTag: desiredTag,
    applied: { tags: nextTags },
    previous: { tags: existing },
  };
}
