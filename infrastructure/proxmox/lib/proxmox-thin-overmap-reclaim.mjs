/**
 * Thin-LV over-map reclaim (early-exit `maintain` path).
 *
 * A thin LV can map more pool blocks than its virtual size (e.g. after a shrink), leaving
 * `WARNING: Thin volume pve/vm-101-disk-0 maps <100.32 GiB while the size is only 24.00 GiB.`
 * The extra blocks are unreachable by the guest but waste pool space and can break thin snapshots.
 *
 * Detect (default, read-only): per node, `lvs` over SSH; flag thin LVs whose mapped size exceeds the
 * LV size by > --min-overmap-pct (default 10) AND > --min-overmap-gib (default 1). lvs caps data_percent
 * at 100, so the mapped size comes from the LVM "maps X while the size is only Y" warning when present.
 * Each LV is mapped to its guest disk key (qemu scsiN/virtioN/sataN/ideN/efidisk0/tpmstate0,
 * lxc rootfs/mpN) via the guest config.
 *
 * Reclaim (--apply, requires --vmid): Proxmox move-disk round trip through temp storage
 * (default nas-1): move storage=<temp> delete=1, verify config, then back to the original storage
 * delete=1, verify config, then re-run lvs on the new LV. Proxmox removes a source volume only after a
 * successful copy; this code also verifies the config after every step and stops (leaving the current
 * state in place) on any failure. QEMU guests can stay running (drive-mirror). LXC move_volume needs the
 * CT stopped: CTs are skipped unless --allow-ct is passed AND the CT is already stopped. Guests with
 * snapshots are skipped. Disk options (replicate, discard, ...) and HA/replication settings carry over.
 *
 * Usage:
 *   hdc run infrastructure proxmox maintain -- --thin-overmap [--node <pve-node>] [--vmid <n>]
 *   hdc run infrastructure proxmox maintain -- --thin-overmap --apply --node pve-c --vmid 101 [--temp-storage nas-1]
 * Flags:
 *   --thin-overmap            Enable this path (report only unless --apply)
 *   --apply                   Perform the move-disk round trip (requires --vmid)
 *   --node <pve-node>         Limit to one node
 *   --vmid <n>                Limit to one guest
 *   --disk <key>              Limit to one disk key (e.g. scsi0)
 *   --temp-storage <id>       Intermediate storage (default nas-1; must be active, allow the content, have free space)
 *   --min-overmap-pct <n>     Over-map threshold, percent of LV size (default 10)
 *   --min-overmap-gib <n>     Over-map threshold, GiB (default 1)
 *   --allow-ct                Allow LXC move_volume (only when the CT is already stopped)
 *   --task-timeout-min <n>    Per move task timeout (default 60)
 */
import { spawnSync } from "node:child_process";
import { env as procEnv, stderr as errout } from "node:process";

import { clusterConfigByKey, loadProxmoxHostsByCluster } from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "./proxmox-deploy-auth.mjs";
import { fetchClusterVmResources } from "./proxmox-host-provisioner.mjs";
import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import { resolvePveSshForHost } from "./proxmox-pve-ssh.mjs";
import { extractPveUpid } from "./proxmox-qemu-post-clone.mjs";
import { pveData, pveDataArray, pveFormBody, pveJsonRequest, waitForPveTask } from "./pve-http.mjs";
import { flagGet, flagNumber, parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import {
  shellSingleQuote,
  sshBashLc,
  vaultKeyForProxmoxSshPassword,
} from "hdc/cli/lib/ssh-host-access.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";

const GIB = 1024 ** 3;
/** @type {Record<string, number>} */
const UNIT_BYTES = {
  B: 1,
  KIB: 1024, KB: 1024,
  MIB: 1024 ** 2, MB: 1024 ** 2,
  GIB, GB: GIB,
  TIB: 1024 ** 4, TB: 1024 ** 4,
  PIB: 1024 ** 5, PB: 1024 ** 5,
};
const QEMU_DISK_KEY = /^(scsi|virtio|sata|ide)\d+$|^efidisk0$|^tpmstate0$/;
const LXC_DISK_KEY = /^rootfs$|^mp\d+$/;

export const LVS_COMMAND =
  "lvs --noheadings --nosuffix --units b --separator '|' -o vg_name,lv_name,lv_size,data_percent,pool_lv,lv_attr 2>&1";

/** @param {string} line */
function log(line) {
  errout.write(`[proxmox] thin-overmap: ${line}\n`);
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** @param {number} b */
export function fmtGiB(b) {
  return `${(b / GIB).toFixed(2)} GiB`;
}

/**
 * @param {string} num
 * @param {string | undefined} unit
 */
function toBytes(num, unit) {
  const n = Number(num);
  if (!Number.isFinite(n)) return NaN;
  const u = String(unit ?? "B").replace(/\s+/g, "").toUpperCase();
  return Math.round(n * (UNIT_BYTES[u] ?? 1));
}

/**
 * Parse `Thin volume VG/LV maps X while the size is only Y` warnings.
 * @param {string} text
 * @returns {Map<string, { mappedBytes: number; sizeBytes: number; approximate: boolean; line: string }>} key `vg/lv`
 */
export function parseOvermapWarnings(text) {
  const out = new Map();
  const re =
    /Thin volume (\S+?)\/(\S+) maps (<)?\s*([\d.]+)\s*([KMGTP]i?B|B)?\s+while the size is only (<)?\s*([\d.]+)\s*([KMGTP]i?B|B)?/;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    out.set(`${m[1]}/${m[2]}`, {
      mappedBytes: toBytes(m[4], m[5]),
      sizeBytes: toBytes(m[7], m[8]),
      approximate: Boolean(m[3] || m[6] || (m[5] && m[5] !== "B")),
      line: line.trim(),
    });
  }
  return out;
}

/**
 * @typedef {object} ThinLvRow
 * @property {string} vg
 * @property {string} lv
 * @property {number} sizeBytes
 * @property {number | null} dataPercent
 * @property {string} pool
 * @property {string} attr
 * @property {boolean} active
 */

/**
 * Parse {@link LVS_COMMAND} output (thin volumes only).
 * @param {string} text
 * @returns {ThinLvRow[]}
 */
export function parseLvsThinRows(text) {
  /** @type {ThinLvRow[]} */
  const rows = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /WARNING/.test(line)) continue;
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 6) continue;
    const [vg, lv, size, data, pool, attr] = parts;
    if (!pool || !attr.startsWith("V")) continue;
    const sizeBytes = Number(size);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) continue;
    const dp = data === "" ? null : Number(data);
    rows.push({
      vg,
      lv,
      sizeBytes,
      dataPercent: dp !== null && Number.isFinite(dp) ? dp : null,
      pool,
      attr,
      active: attr.length > 4 && attr[4] === "a",
    });
  }
  return rows;
}

/**
 * @typedef {object} OvermapFinding
 * @property {string} vg
 * @property {string} lv
 * @property {string} pool
 * @property {number} sizeBytes
 * @property {number | null} mappedBytes
 * @property {number | null} overBytes
 * @property {boolean} active
 * @property {boolean} candidate
 * @property {string} [warning]
 */

/**
 * @param {ThinLvRow[]} rows
 * @param {ReturnType<typeof parseOvermapWarnings>} warnings
 * @param {{ minPct: number; minGiB: number }} th
 * @returns {OvermapFinding[]}
 */
export function findOvermappedThinLvs(rows, warnings, th) {
  /** @type {OvermapFinding[]} */
  const out = [];
  for (const r of rows) {
    const w = warnings.get(`${r.vg}/${r.lv}`);
    /** @type {number | null} */
    let mapped = null;
    if (w && Number.isFinite(w.mappedBytes)) mapped = w.mappedBytes;
    else if (r.dataPercent !== null) mapped = Math.round((r.dataPercent / 100) * r.sizeBytes);
    const over = mapped === null ? null : mapped - r.sizeBytes;
    const candidate =
      over !== null && over > (r.sizeBytes * th.minPct) / 100 && over > th.minGiB * GIB;
    if (!candidate && !w) continue;
    out.push({
      vg: r.vg,
      lv: r.lv,
      pool: r.pool,
      sizeBytes: r.sizeBytes,
      mappedBytes: mapped,
      overBytes: over,
      active: r.active,
      candidate,
      ...(w ? { warning: w.line } : {}),
    });
  }
  return out;
}

/**
 * Find the config key referencing `<storage>:<lv>` (ignores unusedN).
 * @param {Record<string, unknown>} config
 * @param {string} volid
 * @param {"qemu" | "lxc"} type
 * @returns {{ key: string; value: string } | null}
 */
export function findDiskKeyForVolid(config, volid, type) {
  const keyRe = type === "lxc" ? LXC_DISK_KEY : QEMU_DISK_KEY;
  for (const [k, v] of Object.entries(config)) {
    if (!keyRe.test(k) || typeof v !== "string") continue;
    if (volidOf(v) === volid) return { key: k, value: v };
  }
  return null;
}

/** @param {string} value e.g. `local-lvm:vm-101-disk-0,size=24G` */
function volidOf(value) {
  return String(value ?? "").split(",")[0].trim();
}

/** @param {string} volid */
function storageOf(volid) {
  const i = volid.indexOf(":");
  return i > 0 ? volid.slice(0, i) : "";
}

/**
 * Per-node root shell: pubkey SSH, else vault password (HDC_PROXMOX_SSH_PASSWORD_<HOST>), else a hop
 * through another reachable cluster node (PVE nodes trust each other's root keys).
 * @param {{ members: import("./proxmox-config.mjs").ProxmoxClusterMember[]; clumpRoot: string; vault: ReturnType<typeof createVaultAccess> }} opts
 */
export function createPveNodeShell(opts) {
  const { members, clumpRoot, vault } = opts;
  /** @typedef {(cmd: string) => { status: number; stdout: string; stderr: string }} NodeRun */
  /** @type {Map<string, NodeRun | null>} */
  const direct = new Map();
  /** @type {Map<string, NodeRun | null>} */
  const resolved = new Map();

  /** @param {import("./proxmox-config.mjs").ProxmoxClusterMember} m */
  function targetFor(m) {
    try {
      return resolvePveSshForHost(clumpRoot, m.id);
    } catch {
      const ip = typeof m.host.ip === "string" ? m.host.ip : "";
      return ip ? { user: "root", host: ip } : null;
    }
  }

  /** @param {import("./proxmox-config.mjs").ProxmoxClusterMember} m @returns {Promise<NodeRun | null>} */
  async function directFor(m) {
    if (direct.has(m.pveNode)) return direct.get(m.pveNode) ?? null;
    /** @type {NodeRun | null} */
    let fn = null;
    const t = targetFor(m);
    if (t) {
      const probe = sshRemote(t.user, t.host, "true", { capture: true, timeoutMs: 30_000 });
      if (probe.status === 0) {
        fn = (cmd) => sshRemote(t.user, t.host, cmd, { capture: true, timeoutMs: 300_000 });
      } else {
        const pw = String(
          (await vault.getSecret(vaultKeyForProxmoxSshPassword(m.id), { optional: true })) ?? "",
        ).trim();
        if (pw) {
          /** @type {NodeRun} */
          const run = (cmd) => {
            const r = sshBashLc(t, cmd, { spawnSync, env: procEnv, mode: "password", password: pw, timeoutMs: 300_000 });
            return {
              status: r.status ?? 1,
              stdout: String(r.stdout ?? ""),
              stderr: String(r.stderr ?? "").split(pw).join("***"),
            };
          };
          if (run("true").status === 0) fn = run;
        }
      }
    }
    direct.set(m.pveNode, fn);
    return fn;
  }

  /** @param {string} pveNode @returns {Promise<NodeRun | null>} */
  async function get(pveNode) {
    if (resolved.has(pveNode)) return resolved.get(pveNode) ?? null;
    const m = members.find((x) => x.pveNode === pveNode);
    if (!m) return null;
    let fn = await directFor(m);
    const t = targetFor(m);
    if (!fn && t) {
      for (const other of members) {
        if (other.pveNode === pveNode) continue;
        const via = await directFor(other);
        if (!via) continue;
        /** @type {NodeRun} */
        const hop = (cmd) =>
          via(`ssh -o BatchMode=yes -o ConnectTimeout=15 ${t.user}@${t.host} ${shellSingleQuote(cmd)}`);
        if (hop("true").status === 0) {
          log(`${pveNode}: SSH via ${other.pveNode} (cluster key hop)`);
          fn = hop;
          break;
        }
      }
    }
    resolved.set(pveNode, fn);
    return fn;
  }

  return { get };
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
 * Early-exit: `--thin-overmap` (report) / `--thin-overmap --apply --vmid N` (reclaim).
 * @param {string[]} argv
 * @param {string} clumpRoot
 * @returns {Promise<{ handled: boolean; ok?: boolean; result?: object }>}
 */
export async function maybeRunProxmoxThinOvermapReclaim(argv, clumpRoot) {
  const flags = parseArgvFlags(argv);
  if (flags["thin-overmap"] === undefined && flags.thin_overmap === undefined) return { handled: false };

  const apply = flags.apply !== undefined;
  const nodeFilter = flagGet(flags, "node");
  const vmidRaw = flagGet(flags, "vmid");
  const diskFilter = flagGet(flags, "disk");
  if (vmidRaw !== undefined && !/^\d+$/.test(vmidRaw)) throw new Error("--vmid must be a number");
  const vmidFilter = vmidRaw ? Number(vmidRaw) : null;
  if (apply && vmidFilter === null) throw new Error("--thin-overmap --apply requires --vmid <n>");
  const tempStorage = flagGet(flags, "temp-storage", "temp_storage") || "nas-1";
  const th = {
    minPct: flagNumber(flagGet(flags, "min-overmap-pct", "min_overmap_pct"), 10) ?? 10,
    minGiB: flagNumber(flagGet(flags, "min-overmap-gib", "min_overmap_gib"), 1) ?? 1,
  };
  const allowCt = flags["allow-ct"] !== undefined || flags.allow_ct !== undefined;
  const taskTimeoutMs =
    (flagNumber(flagGet(flags, "task-timeout-min", "task_timeout_min"), 60) ?? 60) * 60_000;

  const vault = createVaultAccess(vaultDepsFromCli(createNodeCliDeps()));
  const auth = await authorizeLead(clumpRoot, vault);
  /** @type {(m: string, p: string, f?: Record<string, string | number>) => Promise<unknown>} */
  const api = (m, p, f) =>
    pveJsonRequest(m, auth.apiBase, p, auth.authorization, auth.rejectUnauthorized, f ? pveFormBody(f) : undefined);
  const shell = createPveNodeShell({ members: auth.members, clumpRoot, vault });

  const storageCfg = pveDataArray(await api("GET", "/storage"));
  const resources = await fetchClusterVmResources(auth.apiBase, auth.authorization, auth.rejectUnauthorized);
  const nodes = auth.members
    .map((m) => m.pveNode)
    .filter((n) => !nodeFilter || n === nodeFilter)
    .sort();
  if (nodeFilter && !nodes.length) throw new Error(`--node ${nodeFilter} is not a configured cluster member`);

  /** @type {Record<string, any>[]} */
  const findings = [];
  /** @type {string[]} */
  const warnings = [];
  log(
    `scan ${nodes.length} node(s); threshold >${th.minPct}% and >${th.minGiB} GiB${apply ? " [APPLY]" : " [report only]"}`,
  );

  for (const node of nodes) {
    const run = await shell.get(node);
    if (!run) {
      warnings.push(`${node}: no SSH route (pubkey, vault password, or cluster hop) - skipped`);
      continue;
    }
    const r = run(LVS_COMMAND);
    if (r.status !== 0) {
      warnings.push(`${node}: lvs failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      continue;
    }
    const text = `${r.stdout}\n${r.stderr}`;
    const rows = parseLvsThinRows(text);
    const overmapped = findOvermappedThinLvs(rows, parseOvermapWarnings(text), th);
    const inactiveUnknown = rows.filter((x) => !x.active && x.dataPercent === null).length;
    log(`${node}: ${rows.length} thin LV(s), ${overmapped.length} over-mapped${inactiveUnknown ? `, ${inactiveUnknown} inactive (usage unknown, not evaluated)` : ""}`);

    for (const f of overmapped) {
      const st = storageCfg.find(
        (s) =>
          s.type === "lvmthin" &&
          s.vgname === f.vg &&
          (s.thinpool ?? "data") === f.pool &&
          (!s.nodes || String(s.nodes).split(",").includes(node)),
      );
      const storageId = st ? String(st.storage) : null;
      const vm = /^(?:vm|base)-(\d+)-/.exec(f.lv);
      const vmid = vm ? Number(vm[1]) : null;
      if (vmidFilter !== null && vmid !== vmidFilter) continue;
      /** @type {Record<string, any>} */
      const row = {
        node,
        vg: f.vg,
        lv: f.lv,
        pool: f.pool,
        storage: storageId,
        vmid,
        size: fmtGiB(f.sizeBytes),
        mapped: f.mappedBytes === null ? null : fmtGiB(f.mappedBytes),
        over: f.overBytes === null ? null : fmtGiB(f.overBytes),
        size_bytes: f.sizeBytes,
        mapped_bytes: f.mappedBytes,
        candidate: f.candidate,
        ...(f.warning ? { lvm_warning: f.warning } : {}),
      };
      if (!f.candidate) {
        row.action = "none";
        row.reason = "below threshold";
      } else if (f.lv.startsWith("base-")) {
        row.action = "skip";
        row.reason = "template base volume";
      } else if (!storageId || vmid === null) {
        row.action = "skip";
        row.reason = "no PVE storage / vmid for this LV";
      } else {
        const res = resources.find((x) => x.vmid === vmid);
        const type = res?.type === "lxc" ? "lxc" : "qemu";
        if (!res || res.node !== node) {
          row.action = "skip";
          row.reason = res ? `guest config lives on ${res.node}, not ${node}` : "no guest with this vmid";
        } else {
          const cfg = pveData(await api("GET", `/nodes/${node}/${type}/${vmid}/config`));
          const disk = isObject(cfg) ? findDiskKeyForVolid(cfg, `${storageId}:${f.lv}`, type) : null;
          Object.assign(row, {
            type,
            name: res.name,
            status: res.status,
            disk: disk?.key ?? null,
            disk_config: disk?.value ?? null,
          });
          const snaps = pveDataArray(await api("GET", `/nodes/${node}/${type}/${vmid}/snapshot`)).filter(
            (s) => s.name !== "current",
          );
          if (!disk) {
            row.action = "skip";
            row.reason = "LV not referenced by an active disk key (unused/orphan)";
          } else if (diskFilter && disk.key !== diskFilter) {
            continue;
          } else if (res.template) {
            row.action = "skip";
            row.reason = "template";
          } else if (snaps.length) {
            row.action = "skip";
            row.reason = `has ${snaps.length} snapshot(s); moving with delete=1 is refused while snapshots exist - remove snapshots first`;
          } else if (/media=cdrom/.test(disk.value)) {
            row.action = "skip";
            row.reason = "cloud-init/cdrom volume";
          } else if (type === "lxc" && !(allowCt && res.status === "stopped")) {
            row.action = "skip";
            row.reason = "LXC move_volume needs the CT stopped; stop it and pass --allow-ct";
          } else {
            row.action = apply ? "reclaim" : "would-reclaim";
            row.plan = [
              `move ${disk.key} ${storageId} -> ${tempStorage} (source deleted only after a successful copy)`,
              `move ${disk.key} ${tempStorage} -> ${storageId} (temp deleted only after a successful copy)`,
            ];
            row.note =
              "disk options (e.g. replicate=1), HA and replication settings carry over; the volume name may change";
          }
        }
      }
      findings.push(row);
    }
  }

  for (const f of findings) {
    log(
      `${f.node} ${f.vg}/${f.lv}: size ${f.size}, mapped ${f.mapped ?? "?"}, over ${f.over ?? "?"} -> ${f.action}${f.reason ? ` (${f.reason})` : ""}${f.disk ? ` [vmid ${f.vmid} ${f.disk}]` : ""}`,
    );
  }
  if (!findings.length) log("no over-mapped thin LVs found");

  /** @type {Record<string, any>[]} */
  const applied = [];
  let ok = warnings.length === 0;
  for (const f of findings.filter((x) => x.action === "reclaim")) {
    const step = await reclaimOne({ f, api, auth, shell, tempStorage, taskTimeoutMs });
    applied.push(step);
    if (!step.ok) {
      ok = false;
      break;
    }
  }
  for (const w of warnings) log(`WARN ${w}`);

  return {
    handled: true,
    ok,
    result: {
      ok,
      action: "thin-overmap",
      apply,
      temp_storage: tempStorage,
      thresholds: th,
      findings,
      applied,
      warnings,
    },
  };
}

/**
 * Move-disk round trip for one finding. Stops on the first problem and reports the current state.
 * @param {object} o
 * @param {Record<string, any>} o.f
 * @param {(m: string, p: string, f?: Record<string, string | number>) => Promise<unknown>} o.api
 * @param {{ apiBase: string; authorization: string; rejectUnauthorized: boolean }} o.auth
 * @param {ReturnType<typeof createPveNodeShell>} o.shell
 * @param {string} o.tempStorage
 * @param {number} o.taskTimeoutMs
 */
async function reclaimOne(o) {
  const { f, api, auth, shell, tempStorage, taskTimeoutMs } = o;
  const { node, vmid, type, disk } = f;
  const origStorage = String(f.storage);
  const base = `/nodes/${node}/${type}/${vmid}`;
  /** @type {string[]} */
  const steps = [];
  /** @param {string} msg @param {Record<string, unknown>} [extra] */
  const fail = (msg, extra = {}) => {
    log(`STOP vmid ${vmid} ${disk}: ${msg}`);
    return { ok: false, node, vmid, disk, steps, error: msg, ...extra };
  };
  const currentDisk = async () => {
    const cfg = pveData(await api("GET", `${base}/config`));
    const v = isObject(cfg) && typeof cfg[disk] === "string" ? String(cfg[disk]) : "";
    const unused = isObject(cfg)
      ? Object.entries(cfg)
          .filter(([k]) => /^unused\d+$/.test(k))
          .map(([k, v2]) => `${k}=${v2}`)
      : [];
    return { value: v, volid: volidOf(v), unused };
  };

  const content = type === "lxc" ? "rootdir" : "images";
  const tst = pveData(await api("GET", `/nodes/${node}/storage/${tempStorage}/status`));
  if (!isObject(tst) || Number(tst.active) !== 1 || tst.enabled === 0) {
    return fail(`temp storage ${tempStorage} not active on ${node}`);
  }
  if (!String(tst.content ?? "").split(",").includes(content)) {
    return fail(`temp storage ${tempStorage} does not allow ${content}`);
  }
  if (Number(tst.avail) < f.size_bytes * 1.1) {
    return fail(`temp storage ${tempStorage} has ${fmtGiB(Number(tst.avail))} free, need ${fmtGiB(f.size_bytes * 1.1)}`);
  }

  const start = await currentDisk();
  if (start.volid !== `${origStorage}:${f.lv}`) return fail(`config ${disk} changed since scan (${start.volid})`);
  steps.push(`start ${disk}: ${start.value}`);

  /** @param {string} storage */
  const move = async (storage) => {
    /** @type {Record<string, string | number>} */
    const fields = type === "lxc" ? { volume: disk, storage, delete: 1 } : { disk, storage, delete: 1, format: "raw" };
    const path = type === "lxc" ? `${base}/move_volume` : `${base}/move_disk`;
    log(`vmid ${vmid}: move ${disk} -> ${storage} ...`);
    const upid = extractPveUpid(pveData(await api("POST", path, fields)));
    if (!upid) throw new Error(`no task UPID from ${path}`);
    steps.push(`task ${upid}`);
    await waitForPveTask({
      apiBase: auth.apiBase,
      node,
      upid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      timeoutMs: taskTimeoutMs,
    });
    steps.push(`task OK`);
  };

  // Step 1: original -> temp
  try {
    await move(tempStorage);
  } catch (e) {
    const now = await currentDisk().catch(() => null);
    return fail(`move to ${tempStorage} failed: ${/** @type {Error} */ (e).message}`, { state: now });
  }
  const mid = await currentDisk();
  steps.push(`after move 1 ${disk}: ${mid.value}`);
  if (storageOf(mid.volid) !== tempStorage) {
    return fail(`after move 1 ${disk} is ${mid.volid}, expected ${tempStorage}:*`, { state: mid });
  }
  if (mid.unused.some((u) => u.includes(start.volid))) {
    return fail(`source ${start.volid} was not deleted (left as unused); stopping with disk on ${tempStorage}`, { state: mid });
  }

  // Step 2: temp -> original
  try {
    await move(origStorage);
  } catch (e) {
    const now = await currentDisk().catch(() => null);
    return fail(
      `move back to ${origStorage} failed: ${/** @type {Error} */ (e).message}; disk remains on ${tempStorage}`,
      { state: now },
    );
  }
  const end = await currentDisk();
  steps.push(`after move 2 ${disk}: ${end.value}`);
  if (storageOf(end.volid) !== origStorage) {
    return fail(`after move 2 ${disk} is ${end.volid}, expected ${origStorage}:*`, { state: end });
  }
  if (end.unused.some((u) => u.includes(mid.volid))) {
    return fail(`temp volume ${mid.volid} was not deleted (left as unused)`, { state: end });
  }

  // Verify the new LV is no longer over-mapped.
  /** @type {Record<string, any>} */
  let verify = { checked: false };
  const run = await shell.get(node);
  if (run) {
    const r = run(LVS_COMMAND);
    const text = `${r.stdout}\n${r.stderr}`;
    const newLv = end.volid.split(":")[1] ?? "";
    const row = parseLvsThinRows(text).find((x) => x.lv === newLv);
    const w = parseOvermapWarnings(text).get(`${f.vg}/${newLv}`);
    verify = {
      checked: true,
      lv: newLv,
      size: row ? fmtGiB(row.sizeBytes) : null,
      data_percent: row?.dataPercent ?? null,
      still_overmapped: Boolean(w),
      ...(w ? { lvm_warning: w.line } : {}),
    };
    steps.push(`verify: ${JSON.stringify(verify)}`);
  }
  log(`vmid ${vmid}: ${disk} now ${end.volid} (was ${start.volid})`);
  return { ok: !verify.still_overmapped, node, vmid, disk, from: start.value, to: end.value, steps, verify };
}