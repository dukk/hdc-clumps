/**
 * Backup check-and-fix (early-exit `maintain` path): why are scheduled vzdump jobs failing, and fix
 * the safe, reversible causes.
 *
 * Report (default, read-only). Per cluster, via the Proxmox API:
 *   - recent vzdump results per guest (--since-days, default 7) with the failure reason parsed from
 *     the task log and a cause class (missing-disk, locked, start-failed, storage, other)
 *   - backup storage used by enabled jobs: configured, enabled, active on every node, free space
 *     (warn below --min-free-pct, default 10)
 *   - guests whose config sits on a node where a backed-up disk does not exist ("stranded"), with the
 *     node(s) that do hold the volume
 *   - config locks on guests in enabled jobs; a `backup` lock with no vzdump task running on that node
 *     is "stale" (fixable); any other lock (snapshot, migrate, ...) is reported only
 *   - stopped QEMU guests with PCI passthrough in a job (stop-mode backup must start QEMU)
 *   - jobs that reference missing guests, templates, or guests tagged/named retired; guests that share
 *     a hostname with another guest (old copy vs restored copy) and which copy the job covers
 *   - guests with a backup-* tag that no enabled job covers (/cluster/backup-info/not-backed-up)
 *
 * Fix (--apply), safe and reversible only:
 *   - clear a stale `backup` lock (qm/pct unlock equivalent) when no vzdump task runs on that node
 *   - re-enable a disabled storage that an enabled job targets (PUT /storage delete=disable)
 *   - activate an enabled-but-inactive storage on a node (content listing activates CIFS/NFS mounts)
 * Everything else (removing a guest from a job, moving a guest config between nodes, unlocking a
 * non-backup lock, deleting volumes/backups, stopping guests) is returned as `proposed` with the exact
 * effect and is never done here.
 *
 * Manual backup (--backup-now --vmid N[,M]): one guest at a time, snapshot mode, to the storage of the
 * guest's enabled job (or --storage), with prune-backups keep-all=1 so no existing backup is pruned.
 * Refuses locked guests and guests whose disks are missing on their node.
 *
 * Usage:
 *   hdc run infrastructure proxmox maintain -- --backups [--node pve-c] [--vmid 101] [--since-days 7]
 *   hdc run infrastructure proxmox maintain -- --backups --apply
 *   hdc run infrastructure proxmox maintain -- --backups --backup-now --vmid 101,112
 */
import { stderr as errout } from "node:process";

import { clusterConfigByKey, loadProxmoxHostsByCluster } from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "./proxmox-deploy-auth.mjs";
import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import { extractPveUpid } from "./proxmox-qemu-post-clone.mjs";
import { pveData, pveDataArray, pveFormBody, pveJsonRequest, pveTaskExitIsError, waitForPveTask } from "./pve-http.mjs";
import { createPveNodeShell } from "./proxmox-thin-overmap-reclaim.mjs";
import { flagGet, flagNumber, parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";

const GIB = 1024 ** 3;
const QEMU_DISK_KEY = /^(scsi|virtio|sata|ide)\d+$|^efidisk0$|^tpmstate0$/;
const LXC_DISK_KEY = /^rootfs$|^mp\d+$/;
const RETIRED_RE = /(^|[;,\s-])(retired|decom|decommissioned|old)([;,\s-]|$)/i;

/** @param {string} line */
function log(line) {
  errout.write(`[proxmox] backups: ${line}\n`);
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** @param {number} sec */
export function fmtLocal(sec) {
  return new Date(sec * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }) + " ET";
}

/**
 * Classify a vzdump failure reason.
 * @param {string} reason
 * @returns {"missing-disk" | "locked" | "start-failed" | "storage" | "other"}
 */
export function classifyVzdumpError(reason) {
  const r = String(reason ?? "");
  if (/no such logical volume|does not exist|unable to find|no such file|volume .* not found/i.test(r)) return "missing-disk";
  if (/is locked \(/i.test(r)) return "locked";
  if (/start failed|QEMU exited/i.test(r)) return "start-failed";
  if (/storage .*(not online|not available|is not active)|No space left|unable to (create|open) .*\/mnt\/pve|mount/i.test(r)) return "storage";
  return "other";
}

/**
 * Pull per-guest failure reasons out of a vzdump task log.
 * @param {string[]} lines
 * @returns {Map<number, string>}
 */
export function parseVzdumpLogErrors(lines) {
  const out = new Map();
  for (const l of lines) {
    const m = /ERROR: Backup of VM (\d+) failed - (.+)$/.exec(String(l));
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

/**
 * Expand a backup job's guest selection against cluster resources.
 * @param {Record<string, any>} job
 * @param {Record<string, any>[]} resources
 * @returns {{ vmids: number[]; missing: number[] }}
 */
export function jobGuestSelection(job, resources) {
  const byId = new Map(resources.map((r) => [Number(r.vmid), r]));
  const list = (v) =>
    String(v ?? "")
      .split(/[,\s]+/)
      .map((x) => Number.parseInt(x, 10))
      .filter((x) => Number.isInteger(x) && x > 0);
  /** @type {number[]} */
  let vmids = [];
  /** @type {number[]} */
  const missing = [];
  if (job.all === 1 || job.all === "1" || job.all === true) {
    const ex = new Set(list(job.exclude));
    vmids = resources
      .filter((r) => !ex.has(Number(r.vmid)))
      .filter((r) => !job.node || r.node === job.node)
      .map((r) => Number(r.vmid));
  } else if (job.pool) {
    vmids = resources.filter((r) => r.pool === job.pool).map((r) => Number(r.vmid));
  } else {
    for (const id of list(job.vmid)) {
      if (byId.has(id)) vmids.push(id);
      else missing.push(id);
    }
  }
  return { vmids: [...new Set(vmids)].sort((a, b) => a - b), missing };
}

/**
 * Disks vzdump would include for a guest config.
 * @param {Record<string, unknown>} config
 * @param {"qemu" | "lxc"} type
 * @returns {{ key: string; volid: string; storage: string }[]}
 */
export function backedUpDisks(config, type) {
  /** @type {{ key: string; volid: string; storage: string }[]} */
  const out = [];
  for (const [k, raw] of Object.entries(config)) {
    if (typeof raw !== "string") continue;
    if (type === "qemu" && !QEMU_DISK_KEY.test(k)) continue;
    if (type === "lxc" && !LXC_DISK_KEY.test(k)) continue;
    const volid = raw.split(",")[0].trim();
    if (!volid || volid === "none" || !volid.includes(":") || volid.startsWith("/")) continue;
    if (/(^|,)media=cdrom(,|$)/.test(raw)) continue;
    if (/(^|,)backup=0(,|$)/.test(raw)) continue;
    if (type === "lxc" && k !== "rootfs" && !/(^|,)backup=1(,|$)/.test(raw)) continue;
    out.push({ key: k, volid, storage: volid.slice(0, volid.indexOf(":")) });
  }
  return out;
}

/**
 * @param {string} clumpRoot
 * @param {ReturnType<typeof createVaultAccess>} vault
 */
async function authorizeLead(clumpRoot, vault) {
  const loaded = loadProxmoxPackageConfig(clumpRoot);
  const cfg = loaded.data;
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: loaded.path,
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: (id, reason) => log(`skip ${JSON.stringify(id)} (${reason})`),
  });
  for (const ck of [...byCluster.keys()].sort()) {
    const members = byCluster.get(ck);
    if (!members?.length) continue;
    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn: (m) => log(`WARN ${m}`),
      verifyPaths: PROXMOX_MAINTAIN_VERIFY_PATHS,
      configCluster: clusterConfigByKey(cfg, ck),
      log,
    });
    if (auth) {
      return {
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        members,
      };
    }
  }
  throw new Error("Could not authorize any Proxmox API endpoint");
}

/**
 * Early-exit: `--backups` (report) / `--backups --apply` (safe fixes) / `--backups --backup-now --vmid N`.
 * @param {string[]} argv
 * @param {string} clumpRoot
 * @returns {Promise<{ handled: boolean; ok?: boolean; result?: object }>}
 */
export async function maybeRunProxmoxBackupCheck(argv, clumpRoot) {
  const flags = parseArgvFlags(argv);
  if (flags.backups === undefined) return { handled: false };

  const apply = flags.apply !== undefined;
  const backupNow = flags["backup-now"] !== undefined || flags.backup_now !== undefined;
  const nodeFilter = flagGet(flags, "node");
  const vmidRaw = flagGet(flags, "vmid");
  if (vmidRaw !== undefined && !/^\d+(,\d+)*$/.test(vmidRaw)) throw new Error("--vmid must be N or N,M,...");
  const vmidFilter = vmidRaw ? new Set(vmidRaw.split(",").map(Number)) : null;
  if (backupNow && !vmidFilter) throw new Error("--backup-now requires --vmid N[,M]");
  const sinceDays = flagNumber(flagGet(flags, "since-days", "since_days"), 7) ?? 7;
  const minFreePct = flagNumber(flagGet(flags, "min-free-pct", "min_free_pct"), 10) ?? 10;
  const storageOverride = flagGet(flags, "storage");
  const taskTimeoutMs = (flagNumber(flagGet(flags, "task-timeout-min", "task_timeout_min"), 120) ?? 120) * 60_000;

  const vault = createVaultAccess(vaultDepsFromCli(createNodeCliDeps()));
  const auth = await authorizeLead(clumpRoot, vault);
  /** @type {(m: string, p: string, f?: Record<string, string | number>) => Promise<unknown>} */
  const api = (m, p, f) =>
    pveJsonRequest(m, auth.apiBase, p, auth.authorization, auth.rejectUnauthorized, f ? pveFormBody(f) : undefined);
  /** @type {(p: string) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>} */
  const tryGet = async (p) => {
    try {
      return { ok: true, data: pveData(await api("GET", p)) };
    } catch (e) {
      return { ok: false, error: String(/** @type {Error} */ (e).message || e).slice(0, 300) };
    }
  };
  /** @type {ReturnType<typeof createPveNodeShell> | null} */
  let shell = null;
  const getShell = () => (shell ??= createPveNodeShell({ members: auth.members, clumpRoot, vault }));

  const nodeRows = pveDataArray(await api("GET", "/nodes"));
  const onlineNodes = nodeRows.filter((n) => n.status === "online").map((n) => String(n.node)).sort();
  const offlineNodes = nodeRows.filter((n) => n.status !== "online").map((n) => String(n.node)).sort();
  const resources = pveDataArray(await api("GET", "/cluster/resources?type=vm"));
  const byId = new Map(resources.map((r) => [Number(r.vmid), r]));
  const jobs = pveDataArray(await api("GET", "/cluster/backup"));
  const enabledJobs = jobs.filter((j) => !(j.enabled === 0 || j.enabled === "0" || j.enabled === false));
  const storageCfg = pveDataArray(await api("GET", "/storage"));

  /** @type {Record<string, any>[]} */
  const findings = [];
  /** @type {Record<string, any>[]} */
  const proposed = [];
  /** @type {Record<string, any>[]} */
  const fixes = [];
  /** @type {string[]} */
  const warnings = [];
  if (offlineNodes.length) warnings.push(`offline node(s): ${offlineNodes.join(", ")} - their guests are not checked`);

  // ---- guest -> enabled jobs
  /** @type {Map<number, Record<string, any>[]>} */
  const jobsByVmid = new Map();
  for (const j of jobs) {
    const sel = jobGuestSelection(j, resources);
    const enabled = enabledJobs.includes(j);
    for (const id of sel.missing) {
      findings.push({ check: "job-target", severity: enabled ? "warn" : "info", job: j.id, vmid: id, issue: "job references a vmid that does not exist" });
      proposed.push({ action: "remove-from-job", job: j.id, vmid: id, effect: `job ${j.id} stops trying to back up nonexistent vmid ${id}` });
    }
    for (const id of sel.vmids) {
      if (!enabled) continue;
      const arr = jobsByVmid.get(id) ?? [];
      arr.push(j);
      jobsByVmid.set(id, arr);
    }
  }
  const inScope = (/** @type {number} */ id, /** @type {string} */ node) =>
    (!vmidFilter || vmidFilter.has(id)) && (!nodeFilter || node === nodeFilter);

  // ---- recent vzdump results
  const sinceSec = Math.floor(Date.now() / 1000 - sinceDays * 86400);
  /** @type {Map<number, { last: Record<string, any>; lastOk: Record<string, any> | null; failures: number; reason?: string; cause?: string; failNode?: string }>} */
  const results = new Map();
  /** @type {Set<string>} */
  const nodesWithRunningVzdump = new Set();
  for (const node of onlineNodes) {
    const t = await tryGet(`/nodes/${encodeURIComponent(node)}/tasks?typefilter=vzdump&source=all&limit=5000&since=${sinceSec}`);
    if (!t.ok) {
      warnings.push(`${node}: task list failed: ${t.error}`);
      continue;
    }
    for (const x of /** @type {Record<string, any>[]} */ (Array.isArray(t.data) ? t.data : [])) {
      if (!x.endtime) {
        nodesWithRunningVzdump.add(node);
        continue;
      }
      const id = Number.parseInt(String(x.id ?? ""), 10);
      if (!Number.isInteger(id)) continue;
      const row = results.get(id) ?? { last: x, lastOk: null, failures: 0 };
      if (x.starttime >= row.last.starttime) row.last = { ...x, node };
      if (!pveTaskExitIsError(x.status)) {
        if (!row.lastOk || x.starttime > row.lastOk.starttime) row.lastOk = { ...x, node };
      } else row.failures++;
      results.set(id, row);
    }
  }
  /** @type {Record<string, any>[]} */
  const failing = [];
  for (const [id, row] of [...results].sort((a, b) => a[0] - b[0])) {
    if (!row.failures) continue;
    const r = byId.get(id);
    if (!inScope(id, String(row.last.node))) continue;
    const lastFailed = pveTaskExitIsError(row.last.status);
    let reason = "";
    if (lastFailed) {
      const lg = await tryGet(`/nodes/${encodeURIComponent(row.last.node)}/tasks/${encodeURIComponent(row.last.upid)}/log?limit=1000`);
      const lines = lg.ok && Array.isArray(lg.data) ? lg.data.map((l) => String(l?.t ?? "")) : [];
      reason = parseVzdumpLogErrors(lines).get(id) ?? (lines.filter((l) => /ERROR/.test(l)).pop() || String(row.last.status));
    }
    failing.push({
      vmid: id,
      name: r?.name ?? null,
      node_now: r?.node ?? null,
      failed_on: row.last.node,
      failures: row.failures,
      last_run: fmtLocal(row.last.starttime),
      last_status: lastFailed ? "failed" : "recovered",
      last_ok: row.lastOk ? fmtLocal(row.lastOk.starttime) : null,
      ...(lastFailed ? { reason, cause: classifyVzdumpError(reason) } : {}),
    });
  }

  // ---- storage used by enabled jobs
  const jobStorages = [...new Set(enabledJobs.map((j) => String(j.storage || "local")))].sort();
  for (const sid of jobStorages) {
    const sc = storageCfg.find((s) => s.storage === sid);
    if (!sc) {
      findings.push({ check: "storage", severity: "error", storage: sid, issue: "job targets a storage that is not configured" });
      continue;
    }
    if (sc.disable === 1 || sc.disable === "1") {
      findings.push({ check: "storage", severity: "error", storage: sid, issue: "storage is disabled cluster-wide", fixable: true });
      if (apply) {
        try {
          await api("PUT", `/storage/${encodeURIComponent(sid)}`, { delete: "disable" });
          fixes.push({ fix: "storage-enable", storage: sid, ok: true, undo: `pvesm set ${sid} --disable 1` });
        } catch (e) {
          fixes.push({ fix: "storage-enable", storage: sid, ok: false, error: String(/** @type {Error} */ (e).message) });
        }
      }
    }
    const allowed = sc.nodes ? String(sc.nodes).split(",").map((s) => s.trim()) : null;
    for (const node of onlineNodes) {
      if (nodeFilter && node !== nodeFilter) continue;
      const guestsHere = [...jobsByVmid].filter(
        ([id, js]) => byId.get(id)?.node === node && js.some((j) => String(j.storage || "local") === sid),
      );
      if (allowed && !allowed.includes(node)) {
        if (guestsHere.length) {
          findings.push({ check: "storage", severity: "error", storage: sid, node, issue: `storage not enabled for this node but ${guestsHere.length} guest(s) here back up to it` });
          proposed.push({ action: "storage-add-node", storage: sid, node, effect: `pvesm set ${sid} --nodes ${[...allowed, node].join(",")}` });
        }
        continue;
      }
      let st = await tryGet(`/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(sid)}/status`);
      let d = st.ok && isObject(st.data) ? st.data : null;
      if (!d || Number(d.active) !== 1) {
        findings.push({ check: "storage", severity: "error", storage: sid, node, issue: d ? "storage not active" : `status failed: ${st.ok ? "no data" : st.error}`, fixable: true });
        if (apply) {
          await tryGet(`/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(sid)}/content?content=backup`);
          st = await tryGet(`/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(sid)}/status`);
          d = st.ok && isObject(st.data) ? st.data : null;
          fixes.push({ fix: "storage-activate", storage: sid, node, ok: Boolean(d && Number(d.active) === 1) });
        }
      }
      if (d && Number(d.total) > 0) {
        const freePct = (100 * Number(d.avail)) / Number(d.total);
        const row = { storage: sid, node, avail: `${(Number(d.avail) / GIB).toFixed(0)} GiB`, total: `${(Number(d.total) / GIB).toFixed(0)} GiB`, free_pct: Number(freePct.toFixed(1)) };
        if (freePct < minFreePct) findings.push({ check: "storage", severity: "warn", ...row, issue: `free space below ${minFreePct}%` });
        else findings.push({ check: "storage", severity: "ok", ...row });
      }
    }
  }

  // ---- per guest in enabled jobs: locks, stranded disks, passthrough, retired/template
  const nameCount = new Map();
  for (const r of resources) nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1);
  /** @type {Map<string, { ok: boolean; vols: Set<string> } >} */
  const contentCache = new Map();
  const volumesOn = async (/** @type {string} */ node, /** @type {string} */ sid) => {
    const k = `${node}|${sid}`;
    if (!contentCache.has(k)) {
      const c = await tryGet(`/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(sid)}/content`);
      contentCache.set(k, { ok: c.ok, vols: new Set(c.ok && Array.isArray(c.data) ? c.data.map((x) => String(x?.volid ?? "")) : []) });
    }
    return /** @type {{ ok: boolean; vols: Set<string> }} */ (contentCache.get(k));
  };
  /** @type {Set<number>} */
  const blocked = new Set();

  for (const [id, js] of [...jobsByVmid].sort((a, b) => a[0] - b[0])) {
    const r = byId.get(id);
    if (!r || !inScope(id, String(r.node))) continue;
    const node = String(r.node);
    const type = r.type === "lxc" ? "lxc" : "qemu";
    const jobIds = js.map((j) => j.id);
    if (!onlineNodes.includes(node)) continue;
    if (r.template === 1 || r.template === true) {
      findings.push({ check: "job-target", severity: "warn", vmid: id, name: r.name, jobs: jobIds, issue: "template in a backup job" });
      proposed.push({ action: "remove-from-job", jobs: jobIds, vmid: id, effect: `stop backing up template ${id} (${r.name})` });
    }
    if (RETIRED_RE.test(String(r.tags ?? "")) || RETIRED_RE.test(String(r.name ?? ""))) {
      findings.push({ check: "job-target", severity: "warn", vmid: id, name: r.name, jobs: jobIds, issue: "guest tagged/named retired is still in a job" });
      proposed.push({ action: "remove-from-job", jobs: jobIds, vmid: id, effect: `stop backing up retired guest ${id} (${r.name})` });
    }
    if ((nameCount.get(r.name) ?? 0) > 1) {
      const twins = resources.filter((x) => x.name === r.name && Number(x.vmid) !== id);
      for (const tw of twins) {
        const twId = Number(tw.vmid);
        const twCovered = jobsByVmid.has(twId);
        findings.push({
          check: "duplicate",
          severity: "warn",
          vmid: id,
          name: r.name,
          status: r.status,
          jobs: jobIds,
          twin: { vmid: twId, node: tw.node, status: tw.status, in_enabled_job: twCovered },
          issue: `hostname shared with vmid ${twId} (${tw.status} on ${tw.node}); job covers ${id}${twCovered ? ` and ${twId}` : ` but not ${twId}`}`,
        });
        if (!twCovered && tw.status === "running") {
          for (const j of js) {
            proposed.push({
              action: "retarget-job",
              job: j.id,
              from_vmid: id,
              to_vmid: twId,
              effect: `job ${j.id} (${j.schedule}, ${j.storage}) backs up ${twId} on ${tw.node} instead of ${id}; existing ${id} backups stay on ${j.storage}`,
            });
          }
        }
      }
    }

    const c = await tryGet(`/nodes/${encodeURIComponent(node)}/${type}/${id}/config`);
    if (!c.ok || !isObject(c.data)) {
      findings.push({ check: "config", severity: "error", vmid: id, node, issue: `config read failed: ${c.ok ? "no data" : c.error}` });
      continue;
    }
    const cfg = c.data;
    if (cfg.lock) {
      const lock = String(cfg.lock);
      const stale = lock === "backup" && !nodesWithRunningVzdump.has(node);
      findings.push({
        check: "lock",
        severity: "error",
        vmid: id,
        name: r.name,
        node,
        status: r.status,
        lock,
        jobs: jobIds,
        issue: stale ? "stale backup lock (no vzdump running on node)" : lock === "backup" ? "backup lock while a vzdump runs on node - left alone" : `locked (${lock}); vzdump will fail until cleared`,
        fixable: stale,
      });
      if (stale && apply) {
        fixes.push(await clearBackupLock({ api, node, type, vmid: id, getShell }));
      } else if (!stale) {
        blocked.add(id);
        const snaps = pveDataArray(await api("GET", `/nodes/${encodeURIComponent(node)}/${type}/${id}/snapshot`).catch(() => ({ data: [] })))
          .filter((s) => s.name !== "current")
          .map((s) => `${s.name}${s.snaptime ? ` (${fmtLocal(Number(s.snaptime))})` : ""}`);
        proposed.push({
          action: "unlock",
          vmid: id,
          node,
          lock,
          snapshots: snaps,
          effect: `${type === "lxc" ? "pct" : "qm"} unlock ${id} on ${node}: removes the '${lock}' lock only (guest stays ${r.status}); a leftover 'vzdump' snapshot may also need '${type === "lxc" ? "pct" : "qm"} delsnapshot ${id} vzdump --force'`,
        });
      }
    }

    for (const disk of backedUpDisks(cfg, type)) {
      const sc = storageCfg.find((s) => s.storage === disk.storage);
      const allowed = sc?.nodes ? String(sc.nodes).split(",").map((s) => s.trim()) : null;
      const notOnNode = !sc || (allowed && !allowed.includes(node));
      const here = notOnNode ? { ok: true, vols: new Set() } : await volumesOn(node, disk.storage);
      if (!here.ok) {
        findings.push({ check: "disk", severity: "warn", vmid: id, node, disk: disk.key, volid: disk.volid, issue: "could not list storage content to verify disk" });
        continue;
      }
      if (here.vols.has(disk.volid)) continue;
      /** @type {string[]} */
      const holders = [];
      if (!sc?.shared) {
        for (const other of onlineNodes) {
          if (other === node) continue;
          const v = await volumesOn(other, disk.storage);
          if (v.vols.has(disk.volid)) holders.push(other);
        }
      }
      blocked.add(id);
      const cfgDir = type === "lxc" ? "lxc" : "qemu-server";
      findings.push({
        check: "disk",
        severity: "error",
        vmid: id,
        name: r.name,
        node,
        disk: disk.key,
        volid: disk.volid,
        holders,
        issue: notOnNode
          ? `storage ${disk.storage} is not available on ${node}`
          : `volume missing on ${node}${holders.length ? ` (exists on ${holders.join(", ")}) - guest stranded` : " and not found on any other online node"}`,
      });
      if (holders.length === 1) {
        proposed.push({
          action: "relocate-config",
          vmid: id,
          from: node,
          to: holders[0],
          effect: `mv /etc/pve/nodes/${node}/${cfgDir}/${id}.conf /etc/pve/nodes/${holders[0]}/${cfgDir}/${id}.conf (guest must be stopped; if HA-managed set ha state to disabled first, then restore); reversible by moving it back`,
        });
      }
    }

    if (type === "qemu" && r.status !== "running" && Object.keys(cfg).some((k) => /^hostpci\d+$/.test(k))) {
      const pci = Object.entries(cfg).filter(([k]) => /^hostpci\d+$/.test(k)).map(([k, v]) => `${k}=${v}`);
      const f = failing.find((x) => x.vmid === id);
      findings.push({
        check: "passthrough",
        severity: f?.cause === "start-failed" ? "error" : "warn",
        vmid: id,
        name: r.name,
        node,
        pci,
        jobs: jobIds,
        issue: "stopped VM with PCI passthrough: stop-mode backup has to start QEMU (with the device), which fails if the device is missing/in use",
      });
      proposed.push({
        action: "passthrough-backup",
        vmid: id,
        options: [
          `find why QEMU fails to start on ${node} (journalctl / 'qm start ${id}' with the device), then re-run the backup`,
          `or disable job(s) ${jobIds.join(", ")} while ${r.name} is parked (re-enable later; no data deleted)`,
        ],
      });
    }
  }

  // ---- guests with a backup-* tag that no enabled job covers
  const nb = await tryGet("/cluster/backup-info/not-backed-up");
  const notBackedUp = nb.ok && Array.isArray(nb.data) ? nb.data : [];
  for (const x of notBackedUp) {
    const id = Number(x.vmid);
    const r = byId.get(id);
    if (!r || !inScope(id, String(r.node))) continue;
    if (r.template === 1 || r.template === true) continue;
    const tag = String(r.tags ?? "").split(/[;,\s]+/).find((t) => /^backup-/.test(t));
    if (!tag) continue;
    findings.push({ check: "coverage", severity: r.status === "running" ? "error" : "info", vmid: id, name: r.name, node: r.node, status: r.status, tag, issue: `tagged ${tag} but no enabled backup job covers it` });
  }

  // ---- manual backups
  /** @type {Record<string, any>[]} */
  const manual = [];
  if (backupNow && vmidFilter) {
    for (const id of [...vmidFilter].sort((a, b) => a - b)) {
      manual.push(await backupOne({ api, auth, id, byId, jobsByVmid, blocked, storageOverride, taskTimeoutMs, onlineNodes }));
    }
  }

  // ---- log summary
  for (const f of failing) {
    log(`vzdump ${f.vmid} (${f.name ?? "?"}) on ${f.failed_on}: ${f.failures} failure(s) in ${sinceDays}d, last ${f.last_run} ${f.last_status}${f.reason ? ` - ${f.reason} [${f.cause}]` : ""}${f.node_now && f.node_now !== f.failed_on ? ` (now on ${f.node_now})` : ""}`);
  }
  for (const f of findings.filter((x) => x.severity !== "ok")) {
    log(`${f.severity.toUpperCase()} ${f.check}${f.vmid ? ` vmid ${f.vmid}` : ""}${f.storage ? ` ${f.storage}` : ""}${f.node ? ` @${f.node}` : ""}: ${f.issue}`);
  }
  for (const p of proposed) log(`PROPOSED (needs approval) ${p.action}: ${p.effect ?? (p.options ?? []).join(" | ")}`);
  for (const x of fixes) log(`FIX ${x.fix} ${x.vmid ?? x.storage ?? ""}${x.node ? ` @${x.node}` : ""}: ${x.ok ? "ok" : `failed ${x.error ?? ""}`}`);
  for (const m of manual) log(`BACKUP ${m.vmid}: ${m.ok ? "ok" : "failed"} ${m.archive ?? m.error ?? ""}`);
  for (const w of warnings) log(`WARN ${w}`);

  const errors = findings.filter((f) => f.severity === "error" && !(apply && f.fixable && fixes.some((x) => x.ok && (x.vmid === f.vmid || x.storage === f.storage))));
  const ok = errors.length === 0 && failing.every((f) => f.last_status !== "failed") && manual.every((m) => m.ok) && fixes.every((x) => x.ok);
  return {
    handled: true,
    ok,
    result: {
      ok,
      action: "backups",
      apply,
      since_days: sinceDays,
      failing,
      findings,
      fixes,
      proposed,
      manual_backups: manual,
      jobs: enabledJobs
        .filter((j) => !vmidFilter || jobGuestSelection(j, resources).vmids.some((v) => vmidFilter.has(v)))
        .map((j) => ({ id: j.id, schedule: j.schedule, storage: j.storage, vmid: j.vmid ?? (j.all ? "all" : j.pool ? `pool:${j.pool}` : ""), ...(j["next-run"] ? { next_run: fmtLocal(Number(j["next-run"])) } : {}) })),
      warnings,
    },
  };
}

/**
 * Clear a stale `backup` lock: API first (qemu needs skiplock), then `qm/pct unlock` over SSH.
 * @param {{ api: Function; node: string; type: "qemu" | "lxc"; vmid: number; getShell: () => ReturnType<typeof createPveNodeShell> }} o
 */
async function clearBackupLock(o) {
  const { api, node, type, vmid, getShell } = o;
  const path = `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/config`;
  const still = async () => {
    const c = pveData(await api("GET", path));
    return isObject(c) ? c.lock ?? null : null;
  };
  try {
    if ((await still()) !== "backup") return { fix: "unlock", vmid, node, ok: false, error: "lock changed since scan; left alone" };
    await api("PUT", path, type === "qemu" ? { delete: "lock", skiplock: 1 } : { delete: "lock" });
    if (!(await still())) return { fix: "unlock", vmid, node, ok: true, via: "api", undo: "n/a (lock was stale)" };
  } catch {
    /* fall through to SSH */
  }
  const run = await getShell().get(node);
  if (!run) return { fix: "unlock", vmid, node, ok: false, error: "API refused and no SSH route" };
  const r = run(`${type === "lxc" ? "pct" : "qm"} unlock ${vmid}`);
  const after = await still().catch(() => "unknown");
  return { fix: "unlock", vmid, node, ok: r.status === 0 && !after, via: "ssh", ...(r.status !== 0 ? { error: (r.stderr || r.stdout).trim().slice(0, 200) } : {}) };
}

/**
 * One manual vzdump (snapshot mode, keep-all so nothing is pruned) and verification.
 * @param {Record<string, any>} o
 */
async function backupOne(o) {
  const { api, auth, id, byId, jobsByVmid, blocked, storageOverride, taskTimeoutMs, onlineNodes } = o;
  const r = byId.get(id);
  if (!r) return { vmid: id, ok: false, error: "no such guest" };
  const node = String(r.node);
  if (!onlineNodes.includes(node)) return { vmid: id, ok: false, error: `${node} offline` };
  if (blocked.has(id)) return { vmid: id, ok: false, error: "guest is locked or has a missing disk - fix that first" };
  const type = r.type === "lxc" ? "lxc" : "qemu";
  const cfg = pveData(await api("GET", `/nodes/${encodeURIComponent(node)}/${type}/${id}/config`));
  if (isObject(cfg) && cfg.lock) return { vmid: id, ok: false, error: `locked (${cfg.lock})` };
  const job = (jobsByVmid.get(id) ?? [])[0];
  const storage = storageOverride || job?.storage;
  if (!storage) return { vmid: id, ok: false, error: "no enabled job for this guest; pass --storage" };
  const fields = { vmid: id, storage, mode: "snapshot", compress: job?.compress || "zstd", "prune-backups": "keep-all=1", remove: 0 };
  log(`vmid ${id} (${r.name}) on ${node}: vzdump -> ${storage} (snapshot, keep-all) ...`);
  const started = Math.floor(Date.now() / 1000);
  let upid = null;
  try {
    upid = extractPveUpid(pveData(await api("POST", `/nodes/${encodeURIComponent(node)}/vzdump`, fields)));
    if (!upid) throw new Error("no task UPID");
    await waitForPveTask({ apiBase: auth.apiBase, node, upid, authorization: auth.authorization, rejectUnauthorized: auth.rejectUnauthorized, timeoutMs: taskTimeoutMs });
  } catch (e) {
    let reason = String(/** @type {Error} */ (e).message || e);
    if (upid) {
      const lg = pveDataArray(await api("GET", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log?limit=1000`).catch(() => ({ data: [] })));
      reason = parseVzdumpLogErrors(lg.map((l) => String(l.t ?? ""))).get(id) ?? reason;
    }
    return { vmid: id, name: r.name, node, storage, ok: false, upid, error: reason };
  }
  const content = pveDataArray(await api("GET", `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=backup&vmid=${id}`));
  const fresh = content.filter((x) => Number(x.ctime) >= started - 60).sort((a, b) => Number(b.ctime) - Number(a.ctime))[0];
  return {
    vmid: id,
    name: r.name,
    node,
    storage,
    ok: Boolean(fresh),
    upid,
    ...(fresh ? { archive: String(fresh.volid), size: `${(Number(fresh.size) / GIB).toFixed(2)} GiB`, created: fmtLocal(Number(fresh.ctime)) } : { error: "task OK but no new archive found on storage" }),
  };
}

