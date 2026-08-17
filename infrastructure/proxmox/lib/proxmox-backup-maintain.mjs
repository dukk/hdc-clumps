import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { servicesPackagesDir } from "hdc/package/clumps-root.mjs";

import { tryLoadClumpConfigOrExample } from "hdc/cli/lib/clump-config.mjs";
import { repoRoot as defaultRepoRoot } from "hdc/cli/paths.mjs";
import {
  clusterConfigByKey,
  isProxmoxConfigObject,
  loadProxmoxHostsByCluster,
} from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  proxmoxMaintainVerifyPaths,
} from "./proxmox-deploy-auth.mjs";
import {
  fetchClusterVmResources,
  locateVmidInCluster,
} from "./proxmox-host-provisioner.mjs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { lxcTemplateStorageFromConfig } from "./proxmox-provision-config.mjs";
import { fetchPveStorageList } from "./proxmox-storage-maintain.mjs";
import { pveFormBody, pveJsonRequest, pveDataArray } from "./pve-http.mjs";
import { notificationsMaintainEnabledFromConfig } from "./proxmox-notifications-maintain.mjs";
import { guestNameMatchesSystemId } from "./proxmox-guest-rootdisk-maintain.mjs";
import {
  backupFrequencyTagForProfile,
  ensureGuestBackupFrequencyTag,
  liveBackupFrequencyTag,
  parseProxmoxTags,
} from "./proxmox-guest-tags.mjs";
import { getLxcConfig, getQemuConfig } from "./proxmox-guest-resources.mjs";

/** @typedef {{ schedule: string; prune_backups: string; mode: string; compress: string; storage?: string }} BackupProfileSpec */

/** Night window for staggered jobs: midnight–06:00 local (360 minutes). */
export const BACKUP_STAGGER_WINDOW_MINUTES = 360;

/** Weekday tokens for Proxmox calendar schedules (Mon–Sun). */
export const BACKUP_DOW = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const DEFAULT_BACKUP_PROFILES = {
  weekly: {
    schedule: "sun 03:00",
    prune_backups: "keep-last=3",
    mode: "snapshot",
    compress: "zstd",
  },
  daily: {
    schedule: "03:00",
    prune_backups: "keep-last=3",
    mode: "snapshot",
    compress: "zstd",
  },
  hourly: {
    schedule: "hourly",
    prune_backups: "keep-last=3,keep-daily=7",
    mode: "snapshot",
    compress: "zstd",
  },
  "twice-weekly": {
    schedule: "mon,thu 03:00",
    prune_backups: "keep-last=3",
    mode: "snapshot",
    compress: "zstd",
  },
};

const DEFAULT_JOB_ID_PREFIX = "hdc-backup";
const DEFAULT_DEFAULT_PROFILE = "weekly";
const DEFAULT_DEFAULT_STORAGE = "nas-a";

/** Profiles whose schedule is computed into the midnight–6am window. */
const STAGGERED_PROFILES = new Set(["daily", "weekly", "twice-weekly"]);

const BACKUP_COMPARE_KEYS = [
  "enabled",
  "storage",
  "schedule",
  "vmid",
  "mode",
  "compress",
  "prune-backups",
  "comment",
  "notification-mode",
];

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} s
 * @returns {number}
 */
export function hashStringToUint(s) {
  let h = 2166136261;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * @param {number} minuteOfWindow
 * @returns {string} HH:MM in 00:00–05:59
 */
export function formatNightTime(minuteOfWindow) {
  const span = BACKUP_STAGGER_WINDOW_MINUTES;
  const m = ((Math.floor(minuteOfWindow) % span) + span) % span;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * @param {object} opts
 * @param {string} opts.profile
 * @param {string} opts.systemId
 * @param {number} [opts.index] Sorted index within profile cohort (for even DOW / time spread)
 * @param {number} [opts.total] Cohort size
 * @returns {string}
 */
export function computeStaggeredBackupSchedule(opts) {
  const profile = String(opts.profile ?? "").trim() || "weekly";
  const systemId = String(opts.systemId ?? "");
  const h = hashStringToUint(systemId);

  if (profile === "hourly") return "hourly";

  const useIndex = typeof opts.index === "number" && typeof opts.total === "number" && opts.total > 0;
  const nightMinute = useIndex
    ? Math.floor((opts.index * BACKUP_STAGGER_WINDOW_MINUTES) / opts.total) % BACKUP_STAGGER_WINDOW_MINUTES
    : h % BACKUP_STAGGER_WINDOW_MINUTES;
  const time = formatNightTime(nightMinute);

  if (profile === "daily") return time;

  if (profile === "twice-weekly") {
    const primary = useIndex ? opts.index % 7 : h % 7;
    const gap = 3 + (h % 2); // 3 or 4 → always ≥3 days apart
    const secondary = (primary + gap) % 7;
    const days = [primary, secondary].sort((a, b) => a - b);
    return `${BACKUP_DOW[days[0]]},${BACKUP_DOW[days[1]]} ${time}`;
  }

  // weekly (default)
  const dow = useIndex ? opts.index % 7 : h % 7;
  return `${BACKUP_DOW[dow]} ${time}`;
}

/**
 * Days between two DOW indices (0–6), shortest forward distance on the week.
 * @param {number} a
 * @param {number} b
 */
export function weekdayGapDays(a, b) {
  return Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
}

/**
 * @param {string} schedule
 * @returns {{ days: string[]; time: string | null }}
 */
export function parseBackupScheduleParts(schedule) {
  const s = String(schedule ?? "").trim().toLowerCase();
  if (!s || s === "hourly" || s === "daily") {
    return { days: [], time: s === "hourly" || s === "daily" ? null : null };
  }
  const m = s.match(/^([a-z,]+)\s+(\d{1,2}:\d{2})$/);
  if (m) {
    return {
      days: m[1]
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
      time: m[2],
    };
  }
  const timeOnly = s.match(/^(\d{1,2}:\d{2})$/);
  if (timeOnly) return { days: [], time: timeOnly[1] };
  return { days: [], time: null };
}

/**
 * @param {unknown} cfg
 */
export function backupMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const backups = provision.backups;
  if (!isObject(backups)) return true;
  return backups.enabled !== false && backups.enabled !== 0;
}

/**
 * @param {unknown} cfg
 */
export function backupManageFromDeployments(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const backups = provision.backups;
  if (!isObject(backups)) return true;
  return backups.manage_from_deployments !== false && backups.manage_from_deployments !== 0;
}

/**
 * When true (default), non-template cluster guests missing from packages get weekly jobs.
 * @param {unknown} cfg
 */
export function backupIncludeClusterOrphansFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const backups = provision.backups;
  if (!isObject(backups)) return true;
  return backups.include_cluster_orphans !== false && backups.include_cluster_orphans !== 0;
}

/**
 * @param {unknown} cfg
 * @returns {Record<string, BackupProfileSpec>}
 */
export function backupProfilesFromConfig(cfg) {
  /** @type {Record<string, BackupProfileSpec>} */
  const merged = { ...DEFAULT_BACKUP_PROFILES };
  if (!isProxmoxConfigObject(cfg)) return merged;
  const provision = cfg.provision;
  if (!isObject(provision)) return merged;
  const backups = provision.backups;
  if (!isObject(backups)) return merged;
  const profiles = backups.profiles;
  if (!isObject(profiles)) return merged;
  for (const [name, spec] of Object.entries(profiles)) {
    if (!isObject(spec)) continue;
    const base = merged[name] ?? DEFAULT_BACKUP_PROFILES.weekly;
    merged[name] = {
      schedule: typeof spec.schedule === "string" && spec.schedule.trim() ? spec.schedule.trim() : base.schedule,
      prune_backups:
        typeof spec.prune_backups === "string" && spec.prune_backups.trim()
          ? spec.prune_backups.trim()
          : base.prune_backups,
      mode: typeof spec.mode === "string" && spec.mode.trim() ? spec.mode.trim() : base.mode,
      compress: typeof spec.compress === "string" && spec.compress.trim() ? spec.compress.trim() : base.compress,
      storage: typeof spec.storage === "string" && spec.storage.trim() ? spec.storage.trim() : base.storage,
    };
  }
  return merged;
}

/**
 * @param {unknown} cfg
 */
export function backupDefaultStorageFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return DEFAULT_DEFAULT_STORAGE;
  const provision = cfg.provision;
  if (!isObject(provision)) return DEFAULT_DEFAULT_STORAGE;
  const backups = provision.backups;
  if (!isObject(backups)) return DEFAULT_DEFAULT_STORAGE;
  const storage = backups.default_storage;
  return typeof storage === "string" && storage.trim() ? storage.trim() : DEFAULT_DEFAULT_STORAGE;
}

/**
 * @param {unknown} cfg
 */
export function backupDefaultProfileFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return DEFAULT_DEFAULT_PROFILE;
  const provision = cfg.provision;
  if (!isObject(provision)) return DEFAULT_DEFAULT_PROFILE;
  const backups = provision.backups;
  if (!isObject(backups)) return DEFAULT_DEFAULT_PROFILE;
  const profile = backups.default_profile;
  return typeof profile === "string" && profile.trim() ? profile.trim() : DEFAULT_DEFAULT_PROFILE;
}

/**
 * @param {unknown} cfg
 */
export function backupJobIdPrefixFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return DEFAULT_JOB_ID_PREFIX;
  const provision = cfg.provision;
  if (!isObject(provision)) return DEFAULT_JOB_ID_PREFIX;
  const backups = provision.backups;
  if (!isObject(backups)) return DEFAULT_JOB_ID_PREFIX;
  const prefix = backups.job_id_prefix;
  return typeof prefix === "string" && prefix.trim() ? prefix.trim() : DEFAULT_JOB_ID_PREFIX;
}

/**
 * @param {string} systemId
 * @param {string} [prefix]
 */
export function backupJobIdForSystem(systemId, prefix = DEFAULT_JOB_ID_PREFIX) {
  const slug = String(systemId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${slug || "guest"}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePruneBackups(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (!isObject(value)) return String(value).trim();
  /** @type {string[]} */
  const parts = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    const key = String(k).trim();
    if (!key) continue;
    parts.push(`${key}=${String(v).trim()}`);
  }
  return parts.join(",");
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function mergeBackupObjects(a, b) {
  const left = isObject(a) ? { ...a } : {};
  const right = isObject(b) ? { ...b } : {};
  return { ...left, ...right };
}

/**
 * @param {unknown} cfg
 * @param {unknown} serviceBackup
 * @param {{ systemId?: string; index?: number; total?: number; applyStagger?: boolean }} [opts]
 * @returns {{ profile: string; schedule: string; storage: string; prune_backups: string; mode: string; compress: string; frequency_tag: string | null; schedule_explicit: boolean }}
 */
export function resolveBackupSpec(cfg, serviceBackup, opts = {}) {
  const profiles = backupProfilesFromConfig(cfg);
  const defaultProfile = backupDefaultProfileFromConfig(cfg);
  const defaultStorage = backupDefaultStorageFromConfig(cfg);
  const merged = mergeBackupObjects({}, serviceBackup);
  const profileName =
    typeof merged.profile === "string" && merged.profile.trim() ? merged.profile.trim() : defaultProfile;
  const profile = profiles[profileName] ?? profiles[defaultProfile] ?? DEFAULT_BACKUP_PROFILES.weekly;
  const scheduleExplicit =
    typeof merged.schedule === "string" && Boolean(merged.schedule.trim());
  const applyStagger = opts.applyStagger !== false;
  let schedule = scheduleExplicit ? String(merged.schedule).trim() : profile.schedule;
  if (!scheduleExplicit && applyStagger && STAGGERED_PROFILES.has(profileName) && opts.systemId) {
    schedule = computeStaggeredBackupSchedule({
      profile: profileName,
      systemId: opts.systemId,
      index: opts.index,
      total: opts.total,
    });
  } else if (!scheduleExplicit && profileName === "hourly") {
    schedule = "hourly";
  }

  return {
    profile: profileName,
    schedule,
    storage:
      typeof merged.storage === "string" && merged.storage.trim()
        ? merged.storage.trim()
        : profile.storage ?? defaultStorage,
    prune_backups:
      typeof merged.prune_backups === "string" && merged.prune_backups.trim()
        ? merged.prune_backups.trim()
        : profile.prune_backups,
    mode: typeof merged.mode === "string" && merged.mode.trim() ? merged.mode.trim() : profile.mode,
    compress: typeof merged.compress === "string" && merged.compress.trim() ? merged.compress.trim() : profile.compress,
    frequency_tag: backupFrequencyTagForProfile(profileName),
    schedule_explicit: scheduleExplicit,
  };
}

/**
 * Apply cohort-based stagger to package-collected targets (mutates schedule in place).
 * @param {Array<{ systemId: string; backup: ReturnType<typeof resolveBackupSpec> & { schedule_explicit?: boolean } }>} targets
 * @param {unknown} cfg
 */
export function applyStaggeredSchedulesToTargets(targets, cfg) {
  /** @type {Map<string, typeof targets>} */
  const byProfile = new Map();
  for (const t of targets) {
    const profile = t.backup.profile;
    if (!STAGGERED_PROFILES.has(profile)) continue;
    if (t.backup.schedule_explicit) continue;
    if (!byProfile.has(profile)) byProfile.set(profile, []);
    byProfile.get(profile).push(t);
  }
  for (const [, cohort] of byProfile) {
    cohort.sort((a, b) => a.systemId.localeCompare(b.systemId));
    const total = cohort.length;
    for (let i = 0; i < total; i++) {
      const t = cohort[i];
      const next = resolveBackupSpec(cfg, { profile: t.backup.profile }, {
        systemId: t.systemId,
        index: i,
        total,
        applyStagger: true,
      });
      t.backup = {
        ...t.backup,
        schedule: next.schedule,
        frequency_tag: next.frequency_tag,
      };
    }
  }
}

/**
 * @param {unknown} deployment
 * @param {unknown} defaultsBackup
 * @returns {{
 *   systemId: string;
 *   hostId: string;
 *   vmid: number | null;
 *   lookupName: string;
 *   serviceBackup: Record<string, unknown>;
 * } | null}
 */
export function deploymentBackupRow(deployment, defaultsBackup) {
  if (!isObject(deployment)) return null;
  const systemId = typeof deployment.system_id === "string" ? deployment.system_id.trim() : "";
  const px = isObject(deployment.proxmox) ? deployment.proxmox : null;
  if (!px) return null;
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return null;

  const mergedBackup = mergeBackupObjects(defaultsBackup, deployment.backup);
  if (mergedBackup.enabled === false || mergedBackup.enabled === 0) return null;

  const lxc = isObject(px.lxc) ? px.lxc : null;
  const qemu = isObject(px.qemu) ? px.qemu : null;
  /** @type {number | null} */
  let vmid = null;
  if (lxc && typeof lxc.vmid === "number" && lxc.vmid > 0) vmid = lxc.vmid;
  if (qemu && typeof qemu.vmid === "number" && qemu.vmid > 0) vmid = qemu.vmid;

  const lookupName =
    (typeof deployment.hostname === "string" && deployment.hostname.trim()) ||
    (lxc && typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
    (qemu && typeof qemu.hostname === "string" && qemu.hostname.trim()) ||
    systemId;

  return {
    systemId: systemId || lookupName,
    hostId,
    vmid,
    lookupName,
    serviceBackup: mergedBackup,
  };
}

/**
 * Top-level deployments[] plus nested deployment_groups[].deployments[].
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>[]}
 */
export function collectDeploymentsFromPackageData(data) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  if (Array.isArray(data.deployments)) {
    for (const d of data.deployments) {
      if (isObject(d)) rows.push(d);
    }
  }
  if (Array.isArray(data.deployment_groups)) {
    for (const g of data.deployment_groups) {
      if (!isObject(g) || !Array.isArray(g.deployments)) continue;
      for (const d of g.deployments) {
        if (isObject(d)) rows.push(d);
      }
    }
  }
  return rows;
}

/**
 * @param {string} root
 * @param {unknown} cfg
 */
export function collectBackupTargetsFromPackages(root, cfg) {
  /** @type {Map<string, { systemId: string; hostId: string; vmid: number | null; lookupName: string; backup: ReturnType<typeof resolveBackupSpec>; orphan?: boolean }>} */
  const bySystem = new Map();
  const servicesDir = servicesPackagesDir();
  let entries = [];
  try {
    entries = readdirSync(servicesDir);
  } catch {
    return [];
  }
  for (const pkgId of entries) {
    const pkgRoot = join(servicesDir, pkgId);
    try {
      if (!statSync(pkgRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    const exampleRel = `clumps/services/${pkgId}/config.example.json`;
    const loaded = tryLoadClumpConfigOrExample(pkgRoot, { exampleRel });
    if (!loaded || !isObject(loaded.data)) continue;
    const defaultsBackup = isObject(loaded.data.defaults) ? loaded.data.defaults.backup : null;
    const rootBackup = isObject(loaded.data.backup) ? loaded.data.backup : null;
    let deployments = collectDeploymentsFromPackageData(loaded.data);
    if (
      !deployments.length &&
      isObject(loaded.data.deploy) &&
      isObject(loaded.data.proxmox)
    ) {
      deployments = [
        {
          system_id: loaded.data.deploy.system_id,
          mode: loaded.data.deploy.mode,
          hostname:
            isObject(loaded.data.proxmox.lxc) && typeof loaded.data.proxmox.lxc.hostname === "string"
              ? loaded.data.proxmox.lxc.hostname
              : undefined,
          proxmox: loaded.data.proxmox,
          backup: rootBackup,
        },
      ];
    }
    for (const d of deployments) {
      const row = deploymentBackupRow(d, defaultsBackup ?? rootBackup);
      if (!row) continue;
      const backup = resolveBackupSpec(
        cfg,
        mergeBackupObjects(defaultsBackup ?? rootBackup, isObject(d) ? d.backup : null),
        { systemId: row.systemId, applyStagger: false },
      );
      bySystem.set(row.systemId, {
        systemId: row.systemId,
        hostId: row.hostId,
        vmid: row.vmid,
        lookupName: row.lookupName,
        backup,
      });
    }
  }
  const targets = [...bySystem.values()];
  applyStaggeredSchedulesToTargets(targets, cfg);
  return targets;
}

/**
 * True when the live Proxmox guest name matches the backup target's lookup name
 * and/or system id (including optional `vm-` prefix normalization).
 *
 * @param {string} liveName
 * @param {{ systemId?: string; lookupName?: string }} target
 * @returns {boolean}
 */
export function liveGuestMatchesBackupTarget(liveName, target) {
  const live = String(liveName ?? "").trim().toLowerCase();
  if (!live) return false;
  const lookup = typeof target.lookupName === "string" ? target.lookupName.trim() : "";
  const systemId = typeof target.systemId === "string" ? target.systemId.trim() : "";
  if (lookup && live === lookup.toLowerCase()) return true;
  if (lookup && guestNameMatchesSystemId(live, lookup)) return true;
  if (systemId && guestNameMatchesSystemId(live, systemId)) return true;
  return false;
}

/**
 * @param {Record<string, unknown>[]} resources
 * @param {string} name
 * @returns {{ vmid: number; node: string; name: string; template: boolean; type: "lxc"|"qemu" } | null}
 */
export function locateGuestByNameInCluster(resources, name) {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  for (const r of resources) {
    if (typeof r.vmid !== "number") continue;
    const guestName = typeof r.name === "string" ? r.name.trim().toLowerCase() : "";
    if (guestName !== want) continue;
    const node = typeof r.node === "string" ? r.node.trim() : "";
    if (!node) continue;
    const template = r.template === 1 || r.template === true;
    const type = r.type === "lxc" ? "lxc" : "qemu";
    return {
      vmid: r.vmid,
      node,
      name: typeof r.name === "string" ? r.name.trim() : `vmid-${r.vmid}`,
      template,
      type,
    };
  }
  return null;
}

/**
 * Build weekly backup targets for non-template cluster guests not already covered.
 *
 * @param {object} opts
 * @param {Record<string, unknown>[]} opts.resources
 * @param {Set<number>} opts.coveredVmids
 * @param {unknown} opts.cfg
 * @param {string} opts.hostId Fallback host id for cluster membership
 * @returns {Array<{ systemId: string; hostId: string; vmid: number; lookupName: string; backup: ReturnType<typeof resolveBackupSpec>; orphan: true; guestType: "lxc"|"qemu"; node: string }>}
 */
export function collectClusterOrphanBackupTargets(opts) {
  const { resources, coveredVmids, cfg, hostId } = opts;
  /** @type {Array<{ systemId: string; hostId: string; vmid: number; lookupName: string; backup: ReturnType<typeof resolveBackupSpec>; orphan: true; guestType: "lxc"|"qemu"; node: string }>} */
  const orphans = [];
  for (const r of resources) {
    if (typeof r.vmid !== "number") continue;
    if (r.template === 1 || r.template === true) continue;
    if (coveredVmids.has(r.vmid)) continue;
    const type = r.type === "lxc" ? "lxc" : r.type === "qemu" ? "qemu" : null;
    if (!type) continue;
    const node = typeof r.node === "string" ? r.node.trim() : "";
    if (!node) continue;
    const name =
      typeof r.name === "string" && r.name.trim() ? r.name.trim() : `vmid-${r.vmid}`;
    orphans.push({
      systemId: name,
      hostId,
      vmid: r.vmid,
      lookupName: name,
      orphan: true,
      guestType: type,
      node,
      backup: resolveBackupSpec(cfg, { profile: "weekly" }, { systemId: name, applyStagger: false }),
    });
  }
  applyStaggeredSchedulesToTargets(orphans, cfg);
  return orphans;
}

/**
 * @param {object} target
 * @param {ReturnType<typeof resolveBackupSpec>} spec
 * @param {string} jobIdPrefix
 * @param {unknown} [cfg]
 */
export function buildBackupJobBody(target, spec, jobIdPrefix = DEFAULT_JOB_ID_PREFIX, cfg) {
  const id = backupJobIdForSystem(target.systemId, jobIdPrefix);
  /** @type {Record<string, string | number>} */
  const body = {
    id,
    enabled: 1,
    storage: spec.storage,
    schedule: spec.schedule,
    vmid: String(target.vmid),
    mode: spec.mode,
    compress: spec.compress,
    "prune-backups": spec.prune_backups,
    comment: `hdc-managed: ${target.systemId}`,
  };
  if (cfg && notificationsMaintainEnabledFromConfig(cfg)) {
    body["notification-mode"] = "notification-system";
  }
  return body;
}

/**
 * @param {Record<string, unknown>} desired
 * @param {Record<string, unknown>} live
 */
export function backupJobLegacyMailFields(live) {
  /** @type {string[]} */
  const deleteKeys = [];
  if (String(live.mailto ?? "").trim()) deleteKeys.push("mailto");
  if (live.mailnotification !== undefined && live.mailnotification !== null && String(live.mailnotification).trim()) {
    deleteKeys.push("mailnotification");
  }
  return deleteKeys;
}

/**
 * @param {Record<string, unknown>} desired
 * @param {Record<string, unknown>} live
 */
export function buildBackupJobPutForm(desired, live) {
  const deleteKeys = backupJobLegacyMailFields(live);
  const digest = typeof live.digest === "string" ? live.digest : undefined;
  return pveFormBody({
    ...desired,
    ...(deleteKeys.length ? { delete: deleteKeys } : {}),
    ...(digest ? { digest } : {}),
  });
}

/**
 * @param {Record<string, unknown>} desired
 * @param {Record<string, unknown>} live
 */
export function backupJobsMatch(desired, live) {
  for (const key of BACKUP_COMPARE_KEYS) {
    const dVal = desired[key];
    const lVal = live[key];
    if (key === "enabled") {
      const d = dVal === 1 || dVal === true || dVal === "1";
      const l = lVal === 1 || lVal === true || lVal === "1";
      if (d !== l) return false;
      continue;
    }
    if (key === "vmid") {
      if (String(dVal ?? "").trim() !== String(lVal ?? "").trim()) return false;
      continue;
    }
    if (key === "prune-backups") {
      if (normalizePruneBackups(dVal) !== normalizePruneBackups(lVal)) return false;
      continue;
    }
    if (key === "notification-mode") {
      const d = String(dVal ?? "").trim() || "auto";
      const l = String(lVal ?? "").trim() || "auto";
      if (d !== l) return false;
      continue;
    }
    if (String(dVal ?? "").trim() !== String(lVal ?? "").trim()) return false;
  }
  if (backupJobLegacyMailFields(live).length) return false;
  return true;
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function fetchPveBackupJobs(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    "/cluster/backup",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  return pveDataArray(body);
}

/**
 * @param {Record<string, unknown>[]} storageRows
 * @param {string} storageId
 */
export function storageSupportsBackup(storageRows, storageId) {
  const row = storageRows.find((r) => r.storage === storageId);
  if (!row) return { ok: false, reason: "storage not found" };
  const content = typeof row.content === "string" ? row.content : "";
  const types = content.split(",").map((s) => s.trim().toLowerCase());
  if (!types.includes("backup")) {
    return { ok: false, reason: "storage content missing backup" };
  }
  return { ok: true };
}

/**
 * @param {unknown} cfg
 * @returns {Map<string, string>}
 */
export function hostIdToClusterKeyFromConfig(cfg) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!isProxmoxConfigObject(cfg)) return map;
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: "",
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: () => {},
  });
  for (const [clusterKey, members] of byCluster.entries()) {
    for (const m of members) {
      map.set(m.id, clusterKey);
    }
  }
  return map;
}

/**
 * @param {Record<string, unknown>[]} resources
 * @param {number} vmid
 * @returns {{ node: string; name: string; template: boolean; type: "lxc"|"qemu" } | null}
 */
function locateGuestWithType(resources, vmid) {
  const located = locateVmidInCluster(resources, vmid);
  if (!located) return null;
  const row = resources.find((r) => r.vmid === vmid);
  const type = row?.type === "lxc" ? "lxc" : "qemu";
  return { ...located, type };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string} [opts.repoRoot]
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.prune
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 */
export async function runProxmoxBackupMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, prune, vault } = opts;
  const root = opts.repoRoot || defaultRepoRoot();
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "Backup maintain");
  if (!loaded) {
    return { ok: true, skipped: false, results: [] };
  }
  const cfg = loaded.data;

  if (!backupMaintainEnabledFromConfig(cfg)) {
    log("backup maintain: disabled in provision.backups.enabled — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  if (!backupManageFromDeployments(cfg)) {
    log("backup maintain: manage_from_deployments false — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  const jobIdPrefix = backupJobIdPrefixFromConfig(cfg);
  const hostCluster = hostIdToClusterKeyFromConfig(cfg);
  const includeOrphans = backupIncludeClusterOrphansFromConfig(cfg);
  const packageTargets = collectBackupTargetsFromPackages(root, cfg);

  log(
    `backup maintain: ${packageTargets.length} package target(s); prefix ${JSON.stringify(jobIdPrefix)}${includeOrphans ? "; include cluster orphans" : ""}${dryRun ? " [dry-run]" : ""}${prune ? " [prune]" : ""}.`,
  );

  const configPath = join(clumpRoot, "config.json");
  const configRel = "clumps/infrastructure/proxmox/config.json";
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    warn(`backup maintain: no hypervisors in ${configRel}.`);
    return { ok: false, skipped: false, results: [] };
  }

  const lxcStorage = lxcTemplateStorageFromConfig(cfg);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  /** @type {Set<string>} */
  const desiredJobIds = new Set();

  for (const clusterKey of clusterKeys) {
    const members = byCluster.get(clusterKey);
    if (!members?.length) continue;

    const lead = members[0];
    const clusterPackageTargets = packageTargets.filter((t) => hostCluster.get(t.hostId) === clusterKey);

    const configCluster = clusterConfigByKey(cfg, clusterKey);
    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn,
      log,
      configCluster,
      verifyPaths: proxmoxMaintainVerifyPaths(lead.pveNode, lxcStorage),
    });
    if (!auth) {
      ok = false;
      warn(`Skipping cluster ${JSON.stringify(clusterKey)} — no API token.`);
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    let resources = [];
    /** @type {Record<string, unknown>[]} */
    let storageRows = [];
    /** @type {Record<string, unknown>[]} */
    let liveJobs = [];
    try {
      [resources, storageRows, liveJobs] = await Promise.all([
        fetchClusterVmResources(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
        fetchPveStorageList(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
        fetchPveBackupJobs(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
      ]);
    } catch (e) {
      ok = false;
      warn(`Cluster ${JSON.stringify(clusterKey)} API read failed: ${/** @type {Error} */ (e).message || e}`);
      continue;
    }

    /** @type {Set<number>} */
    const coveredVmids = new Set();
    /** @type {Array<any>} */
    const resolvedPackage = [];

    for (const target of clusterPackageTargets) {
      const knownJobId = backupJobIdForSystem(target.systemId, jobIdPrefix);
      let vmid = target.vmid;
      let node = "";
      /** @type {"lxc"|"qemu"|null} */
      let guestType = null;
      if (vmid === null) {
        const located = locateGuestByNameInCluster(resources, target.lookupName);
        if (!located) {
          // Leave job id out of desiredJobIds so prune deletes the stale job.
          warn(
            `[${target.systemId}] guest ${JSON.stringify(target.lookupName)} not found in cluster — skip (job ${JSON.stringify(knownJobId)} eligible for prune).`,
          );
          results.push({
            systemId: target.systemId,
            hostId: target.hostId,
            id: knownJobId,
            profile: target.backup.profile,
            frequencyTag: target.backup.frequency_tag,
            schedule: target.backup.schedule,
            storage: target.backup.storage,
            clusterKey,
            ok: false,
            action: "skipped",
            error: "guest not found",
          });
          continue;
        }
        if (located.template) {
          warn(`[${target.systemId}] ${JSON.stringify(target.lookupName)} is a template — skip.`);
          results.push({
            systemId: target.systemId,
            hostId: target.hostId,
            id: knownJobId,
            profile: target.backup.profile,
            clusterKey,
            ok: false,
            action: "skipped",
            error: "template guest",
          });
          continue;
        }
        vmid = located.vmid;
        node = located.node;
        guestType = located.type;
      } else {
        const located = locateGuestWithType(resources, vmid);
        if (!located) {
          warn(
            `[${target.systemId}] vmid ${vmid} not found in cluster — skip (job ${JSON.stringify(knownJobId)} eligible for prune).`,
          );
          results.push({
            systemId: target.systemId,
            hostId: target.hostId,
            id: knownJobId,
            profile: target.backup.profile,
            vmid,
            clusterKey,
            ok: false,
            action: "skipped",
            error: "vmid not found",
          });
          continue;
        }
        if (located.template) {
          warn(`[${target.systemId}] vmid ${vmid} is a template — skip.`);
          results.push({
            systemId: target.systemId,
            hostId: target.hostId,
            id: knownJobId,
            profile: target.backup.profile,
            vmid,
            clusterKey,
            ok: false,
            action: "skipped",
            error: "template guest",
          });
          continue;
        }
        if (!liveGuestMatchesBackupTarget(located.name, target)) {
          warn(
            `[${target.systemId}] vmid ${vmid} live name ${JSON.stringify(located.name)} does not match lookup ${JSON.stringify(target.lookupName)} / system ${JSON.stringify(target.systemId)} — skip (job ${JSON.stringify(knownJobId)} eligible for prune).`,
          );
          results.push({
            systemId: target.systemId,
            hostId: target.hostId,
            id: knownJobId,
            profile: target.backup.profile,
            vmid,
            clusterKey,
            ok: false,
            action: "skipped",
            error: "vmid name mismatch",
            liveName: located.name,
          });
          continue;
        }
        node = located.node;
        guestType = located.type;
      }
      coveredVmids.add(vmid);
      resolvedPackage.push({ ...target, vmid, node, guestType });
    }

    /** @type {ReturnType<typeof collectClusterOrphanBackupTargets>} */
    let orphans = [];
    if (includeOrphans) {
      orphans = collectClusterOrphanBackupTargets({
        resources,
        coveredVmids,
        cfg,
        hostId: lead.id,
      });
    }

    /** @type {Array<any>} */
    const clusterTargets = [...resolvedPackage, ...orphans];
    if (!clusterTargets.length) {
      log(`Cluster ${JSON.stringify(clusterKey)}: no backup targets.`);
    } else {
      log(
        `Cluster ${JSON.stringify(clusterKey)}: reconcile ${clusterTargets.length} backup job(s) (${resolvedPackage.length} package, ${orphans.length} orphan) …`,
      );
    }

    const liveById = new Map(
      liveJobs.filter((j) => typeof j.id === "string").map((j) => [String(j.id), j]),
    );

    for (const target of clusterTargets) {
      /** @type {Record<string, unknown>} */
      const row = {
        systemId: target.systemId,
        hostId: target.hostId,
        profile: target.backup.profile,
        frequencyTag: target.backup.frequency_tag,
        schedule: target.backup.schedule,
        storage: target.backup.storage,
        clusterKey,
        orphan: Boolean(target.orphan),
      };

      const vmid = target.vmid;
      if (vmid === null || vmid === undefined) {
        warn(`[${target.systemId}] guest ${JSON.stringify(target.lookupName)} not found in cluster — skip.`);
        row.ok = false;
        row.action = "skipped";
        row.error = "guest not found";
        results.push(row);
        continue;
      }

      let node = typeof target.node === "string" ? target.node : "";
      /** @type {"lxc"|"qemu"|null} */
      let guestType = target.guestType ?? null;
      if (!node || !guestType) {
        const located = locateGuestWithType(resources, vmid);
        if (!located) {
          warn(`[${target.systemId}] vmid ${vmid} not found in cluster — skip.`);
          row.ok = false;
          row.action = "skipped";
          row.error = "vmid not found";
          results.push(row);
          continue;
        }
        if (located.template) {
          warn(`[${target.systemId}] vmid ${vmid} is a template — skip.`);
          row.ok = false;
          row.action = "skipped";
          row.error = "template guest";
          results.push(row);
          continue;
        }
        node = located.node;
        guestType = located.type;
      }

      row.vmid = vmid;
      row.node = node;
      row.guestType = guestType;

      const storageCheck = storageSupportsBackup(storageRows, target.backup.storage);
      if (!storageCheck.ok) {
        warn(
          `[${target.systemId}] storage ${JSON.stringify(target.backup.storage)}: ${storageCheck.reason} — job will still be ensured.`,
        );
        row.storageWarning = storageCheck.reason;
      }

      const resolvedTarget = { ...target, vmid };
      const desired = buildBackupJobBody(resolvedTarget, target.backup, jobIdPrefix, cfg);
      const jobId = String(desired.id);
      desiredJobIds.add(jobId);
      row.id = jobId;
      row.desiredTag = target.backup.frequency_tag;

      const live = liveById.get(jobId);
      /** @type {string} */
      let jobAction = "unchanged";
      if (live && backupJobsMatch(desired, live)) {
        log(`[${target.systemId}] backup job ${JSON.stringify(jobId)} OK (${desired.schedule}).`);
        jobAction = "unchanged";
      } else if (live) {
        log(
          `[${target.systemId}] backup job ${JSON.stringify(jobId)} differs — will update${dryRun ? " [dry-run]" : ""}.`,
        );
        jobAction = "update";
      } else {
        log(
          `[${target.systemId}] backup job ${JSON.stringify(jobId)} missing — will create${dryRun ? " [dry-run]" : ""}.`,
        );
        jobAction = "create";
      }

      let jobOk = true;
      if (jobAction !== "unchanged" && !dryRun) {
        try {
          const form = live ? buildBackupJobPutForm(desired, live) : pveFormBody(desired);
          if (live) {
            await pveJsonRequest(
              "PUT",
              auth.host.apiBase,
              `/cluster/backup/${encodeURIComponent(jobId)}`,
              auth.authorization,
              auth.rejectUnauthorized,
              form,
            );
          } else {
            await pveJsonRequest(
              "POST",
              auth.host.apiBase,
              "/cluster/backup",
              auth.authorization,
              auth.rejectUnauthorized,
              form,
            );
          }
          log(`[${target.systemId}] backup job ${JSON.stringify(jobId)} ${live ? "updated" : "created"}.`);
        } catch (e) {
          jobOk = false;
          ok = false;
          const err = /** @type {Error} */ (e).message || String(e);
          warn(`[${target.systemId}] backup job ${JSON.stringify(jobId)} failed: ${err}`);
          row.error = err;
        }
      }

      /** @type {string | null} */
      let liveTag = null;
      let tagOk = true;
      let tagAction = "unchanged";
      const desiredTag = target.backup.frequency_tag;

      if (desiredTag && guestType) {
        if (dryRun) {
          tagAction = "dry-run";
          liveTag = desiredTag;
          log(
            `[${target.systemId}] [dry-run] would ensure ${guestType} ${vmid} frequency tag ${JSON.stringify(desiredTag)}`,
          );
        } else {
          try {
            const tagResult = await ensureGuestBackupFrequencyTag({
              guestType,
              apiBase: auth.host.apiBase,
              authorization: auth.authorization,
              rejectUnauthorized: auth.rejectUnauthorized,
              node,
              vmid,
              profile: target.backup.profile,
              log: (line) => log(`[${target.systemId}] ${line}`),
            });
            tagOk = tagResult.ok !== false;
            tagAction = tagResult.changed ? "updated" : "unchanged";
            liveTag = tagResult.liveTag ?? desiredTag;
            if (!tagOk) {
              ok = false;
              row.error = tagResult.message || "frequency tag ensure failed";
            }
          } catch (e) {
            tagOk = false;
            ok = false;
            const err = /** @type {Error} */ (e).message || String(e);
            warn(`[${target.systemId}] frequency tag failed: ${err}`);
            row.error = err;
          }
        }

        // Validate live tags vs desired (re-read when not dry-run)
        if (!dryRun && tagOk) {
          try {
            const statusOpts = {
              apiBase: auth.host.apiBase,
              authorization: auth.authorization,
              rejectUnauthorized: auth.rejectUnauthorized,
              node,
              vmid,
            };
            const guestCfg =
              guestType === "lxc" ? await getLxcConfig(statusOpts) : await getQemuConfig(statusOpts);
            const tags = parseProxmoxTags(typeof guestCfg.tags === "string" ? guestCfg.tags : "");
            liveTag = liveBackupFrequencyTag(tags);
            if (liveTag !== desiredTag) {
              tagOk = false;
              ok = false;
              const msg = `frequency tag mismatch: live=${JSON.stringify(liveTag)} desired=${JSON.stringify(desiredTag)}`;
              warn(`[${target.systemId}] ${msg}`);
              row.error = msg;
              row.tagValidation = "mismatch";
            } else {
              row.tagValidation = "ok";
            }
          } catch (e) {
            tagOk = false;
            ok = false;
            const err = /** @type {Error} */ (e).message || String(e);
            warn(`[${target.systemId}] frequency tag validate failed: ${err}`);
            row.error = err;
          }
        }
      }

      // Validate schedule/job after write
      let scheduleValidation = "ok";
      if (!dryRun && jobOk) {
        try {
          const refreshed = await fetchPveBackupJobs(
            auth.host.apiBase,
            auth.authorization,
            auth.rejectUnauthorized,
          );
          const liveJob = refreshed.find((j) => j.id === jobId);
          if (!liveJob || !backupJobsMatch(desired, liveJob)) {
            scheduleValidation = "mismatch";
            ok = false;
            jobOk = false;
            const msg = `backup job schedule/spec mismatch for ${JSON.stringify(jobId)}`;
            warn(`[${target.systemId}] ${msg}`);
            row.error = row.error ? `${row.error}; ${msg}` : msg;
          }
        } catch (e) {
          scheduleValidation = "error";
          warn(
            `[${target.systemId}] could not re-fetch backup jobs for validate: ${/** @type {Error} */ (e).message || e}`,
          );
        }
      }

      row.ok = jobOk && tagOk && scheduleValidation === "ok";
      row.action = jobAction;
      row.tagAction = tagAction;
      row.liveTag = liveTag;
      row.scheduleValidation = scheduleValidation;
      if (!row.ok) ok = false;
      results.push(row);
    }

    if (prune) {
      for (const job of liveJobs) {
        const id = typeof job.id === "string" ? job.id.trim() : "";
        if (!id.startsWith(`${jobIdPrefix}-`)) continue;
        if (desiredJobIds.has(id)) continue;
        log(`backup job ${JSON.stringify(id)} stale — will delete${dryRun ? " [dry-run]" : ""}.`);
        /** @type {Record<string, unknown>} */
        const row = { id, action: "delete", clusterKey };
        if (dryRun) {
          row.ok = true;
          results.push(row);
          continue;
        }
        try {
          await pveJsonRequest(
            "DELETE",
            auth.host.apiBase,
            `/cluster/backup/${encodeURIComponent(id)}`,
            auth.authorization,
            auth.rejectUnauthorized,
            undefined,
          );
          log(`backup job ${JSON.stringify(id)} deleted.`);
          row.ok = true;
        } catch (e) {
          ok = false;
          const err = /** @type {Error} */ (e).message || String(e);
          warn(`backup job ${JSON.stringify(id)} delete failed: ${err}`);
          row.ok = false;
          row.error = err;
        }
        results.push(row);
      }
    }
  }

  return { ok, skipped: false, results };
}
