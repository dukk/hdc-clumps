/**
 * Backup job freshness verification: confirm every hdc-managed vzdump job has a
 * recent successful run (task history), not just a reconciled job definition.
 */

import {
  clusterConfigByKey,
  isProxmoxConfigObject,
  loadProxmoxHostsByCluster,
} from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  proxmoxMaintainVerifyPaths,
} from "./proxmox-deploy-auth.mjs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { lxcTemplateStorageFromConfig } from "./proxmox-provision-config.mjs";
import {
  backupJobIdPrefixFromConfig,
  backupMaintainEnabledFromConfig,
  fetchPveBackupJobs,
  parseBackupScheduleParts,
  BACKUP_DOW,
} from "./proxmox-backup-maintain.mjs";
import { pveDataArray, pveJsonRequest, pveTaskExitIsError } from "./pve-http.mjs";

/** Default look-back window when fetching vzdump task history. */
export const DEFAULT_BACKUP_VERIFY_WINDOW_DAYS = 9;

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} cfg
 * @returns {boolean}
 */
export function backupVerifyEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const backups = provision.backups;
  if (!isObject(backups)) return true;
  const verify = backups.verify;
  if (!isObject(verify)) return true;
  return verify.enabled !== false && verify.enabled !== 0;
}

/**
 * @param {unknown} cfg
 * @returns {number}
 */
export function backupVerifyWindowDaysFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return DEFAULT_BACKUP_VERIFY_WINDOW_DAYS;
  const provision = cfg.provision;
  if (!isObject(provision)) return DEFAULT_BACKUP_VERIFY_WINDOW_DAYS;
  const backups = provision.backups;
  if (!isObject(backups)) return DEFAULT_BACKUP_VERIFY_WINDOW_DAYS;
  const verify = backups.verify;
  if (!isObject(verify)) return DEFAULT_BACKUP_VERIFY_WINDOW_DAYS;
  const days = Number(verify.window_days);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_BACKUP_VERIFY_WINDOW_DAYS;
}

/**
 * Longest forward gap in days between scheduled weekdays (week wrap included).
 * @param {string[]} days weekday tokens from parseBackupScheduleParts
 * @returns {number}
 */
export function maxScheduleGapDays(days) {
  const idx = days
    .map((d) => BACKUP_DOW.indexOf(String(d).trim().toLowerCase()))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (idx.length === 0) return 7;
  if (idx.length === 1) return 7;
  let maxGap = 0;
  for (let i = 0; i < idx.length; i++) {
    const next = idx[(i + 1) % idx.length];
    const gap = i + 1 < idx.length ? next - idx[i] : 7 - idx[i] + next;
    if (gap > maxGap) maxGap = gap;
  }
  return maxGap;
}

/**
 * Maximum acceptable age (hours) of the last successful run for a job schedule,
 * with one interval of slack.
 *
 * @param {string} schedule Proxmox calendar schedule (hourly, "HH:MM", "sun 03:00", "mon,thu 03:00")
 * @returns {number}
 */
export function maxBackupAgeHoursForSchedule(schedule) {
  const s = String(schedule ?? "").trim().toLowerCase();
  if (s === "hourly" || s === "*/1:00") return 3;
  if (s === "daily") return 26;
  const parts = parseBackupScheduleParts(s);
  if (parts.time && parts.days.length === 0) return 26; // daily
  if (parts.days.length > 0) {
    return maxScheduleGapDays(parts.days) * 24 + 24;
  }
  // unknown schedule format: assume weekly cadence
  return 8 * 24;
}

/**
 * @typedef {object} VzdumpTaskSummary
 * @property {number} vmid
 * @property {string} upid
 * @property {string} node
 * @property {number} starttime
 * @property {number | null} endtime
 * @property {string} status raw exitstatus ("OK", error text, or "" while running)
 * @property {boolean} running
 */

/**
 * Latest finished (or running) vzdump task per vmid.
 * @param {Record<string, unknown>[]} tasks rows from /nodes/<node>/tasks
 * @returns {Map<number, VzdumpTaskSummary>}
 */
export function latestVzdumpTasksByVmid(tasks) {
  /** @type {Map<number, VzdumpTaskSummary>} */
  const byVmid = new Map();
  for (const t of tasks) {
    if (!isObject(t)) continue;
    if (String(t.type ?? "") !== "vzdump") continue;
    const vmid = Number.parseInt(String(t.id ?? ""), 10);
    if (!Number.isInteger(vmid) || vmid <= 0) continue;
    const starttime = Number(t.starttime);
    if (!Number.isFinite(starttime)) continue;
    const endRaw = Number(t.endtime);
    const endtime = Number.isFinite(endRaw) && endRaw > 0 ? endRaw : null;
    const running = endtime === null;
    /** @type {VzdumpTaskSummary} */
    const summary = {
      vmid,
      upid: String(t.upid ?? ""),
      node: String(t.node ?? ""),
      starttime,
      endtime,
      status: typeof t.status === "string" ? t.status : "",
      running,
    };
    const prev = byVmid.get(vmid);
    const sortKey = endtime ?? starttime;
    const prevKey = prev ? prev.endtime ?? prev.starttime : -1;
    if (!prev || sortKey > prevKey) byVmid.set(vmid, summary);
  }
  return byVmid;
}

/**
 * @typedef {object} BackupVerifyRow
 * @property {string} id job id
 * @property {string} vmid
 * @property {string} schedule
 * @property {number} maxAgeHours
 * @property {"ok" | "running" | "failed" | "stale" | "never"} status
 * @property {boolean} ok
 * @property {string | null} lastRunIso
 * @property {number | null} ageHours
 * @property {string} [error]
 */

/**
 * Check every enabled hdc-managed backup job for a recent successful vzdump run.
 *
 * @param {object} opts
 * @param {Record<string, unknown>[]} opts.jobs rows from /cluster/backup
 * @param {Map<number, VzdumpTaskSummary>} opts.tasksByVmid
 * @param {string} opts.jobIdPrefix
 * @param {number} [opts.nowSec]
 * @returns {{ ok: boolean; rows: BackupVerifyRow[] }}
 */
export function verifyBackupJobFreshness(opts) {
  const { jobs, tasksByVmid, jobIdPrefix } = opts;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  /** @type {BackupVerifyRow[]} */
  const rows = [];
  let ok = true;

  for (const job of jobs) {
    if (!isObject(job)) continue;
    const id = typeof job.id === "string" ? job.id.trim() : "";
    if (!id.startsWith(`${jobIdPrefix}-`)) continue;
    const enabled = job.enabled;
    if (enabled === 0 || enabled === false || enabled === "0") continue;

    const schedule = String(job.schedule ?? "").trim();
    const maxAgeHours = maxBackupAgeHoursForSchedule(schedule);
    const vmids = String(job.vmid ?? "")
      .split(",")
      .map((v) => Number.parseInt(v.trim(), 10))
      .filter((v) => Number.isInteger(v) && v > 0);

    /** @type {BackupVerifyRow} */
    const row = {
      id,
      vmid: String(job.vmid ?? ""),
      schedule,
      maxAgeHours,
      status: "ok",
      ok: true,
      lastRunIso: null,
      ageHours: null,
    };

    for (const vmid of vmids) {
      const task = tasksByVmid.get(vmid);
      if (!task) {
        row.status = "never";
        row.ok = false;
        row.error = `no vzdump run found for vmid ${vmid} in the look-back window`;
        break;
      }
      if (task.running) {
        if (row.status === "ok") row.status = "running";
        continue;
      }
      const endtime = /** @type {number} */ (task.endtime);
      const ageHours = (nowSec - endtime) / 3600;
      const iso = new Date(endtime * 1000).toISOString();
      if (row.ageHours === null || ageHours > row.ageHours) {
        row.ageHours = Math.round(ageHours * 10) / 10;
        row.lastRunIso = iso;
      }
      if (pveTaskExitIsError(task.status)) {
        row.status = "failed";
        row.ok = false;
        row.error = `last run for vmid ${vmid} failed: ${task.status || "unknown"}`;
        break;
      }
      if (ageHours > maxAgeHours) {
        row.status = "stale";
        row.ok = false;
        row.error = `last successful run for vmid ${vmid} is ${Math.round(ageHours)}h old (max ${maxAgeHours}h)`;
        break;
      }
    }

    if (!row.ok) ok = false;
    rows.push(row);
  }

  return { ok, rows };
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<string[]>} cluster node names
 */
async function fetchClusterNodeNames(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    "/nodes",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  return pveDataArray(body)
    .map((r) => (typeof r.node === "string" ? r.node.trim() : ""))
    .filter(Boolean);
}

/**
 * @param {string} apiBase
 * @param {string} node
 * @param {number} sinceSec
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function fetchNodeVzdumpTasks(apiBase, node, sinceSec, authorization, rejectUnauthorized) {
  const path =
    `/nodes/${encodeURIComponent(node)}/tasks` +
    `?typefilter=vzdump&source=all&limit=1000&since=${encodeURIComponent(String(sinceSec))}`;
  const body = await pveJsonRequest("GET", apiBase, path, authorization, rejectUnauthorized, undefined);
  return pveDataArray(body);
}

/**
 * Verify recent backup success for every hdc-managed job on each cluster.
 * Read-only (safe under --dry-run).
 *
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 * @returns {Promise<{ ok: boolean; skipped: boolean; results: BackupVerifyRow[] }>}
 */
export async function runProxmoxBackupVerify(opts) {
  const { clumpRoot, log, warn, vault } = opts;
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "Backup verify");
  if (!loaded) {
    return { ok: true, skipped: true, results: [] };
  }
  const cfg = loaded.data;

  if (!backupMaintainEnabledFromConfig(cfg) || !backupVerifyEnabledFromConfig(cfg)) {
    log("backup verify: disabled in provision.backups — skip.");
    return { ok: true, skipped: true, results: [] };
  }

  const jobIdPrefix = backupJobIdPrefixFromConfig(cfg);
  const windowDays = backupVerifyWindowDaysFromConfig(cfg);
  const sinceSec = Math.floor(Date.now() / 1000) - windowDays * 24 * 3600;

  const configPath = "";
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    warn("backup verify: no hypervisors configured.");
    return { ok: false, skipped: false, results: [] };
  }

  const lxcStorage = lxcTemplateStorageFromConfig(cfg);
  /** @type {BackupVerifyRow[]} */
  const results = [];
  let ok = true;

  for (const clusterKey of clusterKeys) {
    const members = byCluster.get(clusterKey);
    if (!members?.length) continue;
    const lead = members[0];
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
      warn(`backup verify: cluster ${JSON.stringify(clusterKey)} — no API token.`);
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    let jobs = [];
    /** @type {string[]} */
    let nodes = [];
    try {
      [jobs, nodes] = await Promise.all([
        fetchPveBackupJobs(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
        fetchClusterNodeNames(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
      ]);
    } catch (e) {
      ok = false;
      warn(
        `backup verify: cluster ${JSON.stringify(clusterKey)} API read failed: ${/** @type {Error} */ (e).message || e}`,
      );
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    const tasks = [];
    for (const node of nodes) {
      try {
        tasks.push(
          ...(await fetchNodeVzdumpTasks(
            auth.host.apiBase,
            node,
            sinceSec,
            auth.authorization,
            auth.rejectUnauthorized,
          )),
        );
      } catch (e) {
        warn(
          `backup verify: node ${JSON.stringify(node)} task read failed: ${/** @type {Error} */ (e).message || e}`,
        );
      }
    }

    const tasksByVmid = latestVzdumpTasksByVmid(tasks);
    const verified = verifyBackupJobFreshness({ jobs, tasksByVmid, jobIdPrefix });
    if (!verified.ok) ok = false;

    for (const row of verified.rows) {
      const line =
        `[backup-verify] ${row.id} vmid=${row.vmid} schedule=${JSON.stringify(row.schedule)} ` +
        `last=${row.lastRunIso ?? "never"} age=${row.ageHours ?? "?"}h max=${row.maxAgeHours}h → ${row.status}`;
      if (row.ok) log(line);
      else warn(`${line}${row.error ? ` (${row.error})` : ""}`);
      results.push(row);
    }
    log(
      `backup verify: cluster ${JSON.stringify(clusterKey)}: ${verified.rows.length} job(s), ` +
        `${verified.rows.filter((r) => !r.ok).length} failing/stale.`,
    );
  }

  return { ok, skipped: false, results };
}
