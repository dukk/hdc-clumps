import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { loadManualSystemSidecar, primaryIpFromSystem } from "hdc/package/inventory-sidecar.mjs";
import { growRootFilesystemScript } from "hdc/package/qemu-rootfs-resize.mjs";
import {
  pctExec,
  qemuGuestExec,
  sshRemote,
} from "hdc/package/pve-pct-remote.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { parseSshUrl } from "hdc/cli/lib/users-bootstrap-hdc.mjs";
import { hdcPrivateRoot } from "hdc/cli/lib/private-repo.mjs";
import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "./proxmox-deploy-auth.mjs";
import { fetchClusterVmResources } from "./proxmox-host-provisioner.mjs";
import {
  CRIT_PCT,
  guestConfigFromResource,
  isGuestResource,
  storagePoolsForNode,
} from "./proxmox-host-load-report.mjs";
import { loadProxmoxHostsByCluster, isProxmoxConfigObject } from "./proxmox-config.mjs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { fetchPveStorageList } from "./proxmox-storage-maintain.mjs";

export const ROOT_DF_SCRIPT =
  "df -B1 --output=size,used,avail / 2>/dev/null | tail -1";

export const DEFAULT_MAX_USED_PERCENT = 50;
export const DEFAULT_INCREMENT_GB = 8;
export const MAX_EXPANSION_STEPS = 32;

export const DEFAULT_SKIP_NAME_PATTERNS = ["win", "windows", "homeassistant", "haos"];

const GIB = 1024 ** 3;

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @typedef {object} RootDfStats
 * @property {number} sizeBytes
 * @property {number} usedBytes
 * @property {number} availBytes
 */

/**
 * @typedef {object} GuestRootdiskRow
 * @property {number} vmid
 * @property {string} name
 * @property {string} type
 * @property {string} node
 * @property {string} status
 * @property {"ok" | "expanded" | "skipped" | "failed" | "dry_run"} outcome
 * @property {number | null} [before_used_percent]
 * @property {number | null} [after_used_percent]
 * @property {number} [expanded_gb]
 * @property {string} [method]
 * @property {string} [message]
 */

/**
 * @typedef {object} GuestRootdiskReportData
 * @property {boolean} ok
 * @property {string[]} warnings
 * @property {GuestRootdiskRow[]} guests
 * @property {number} max_used_percent
 * @property {number} increment_gb
 */

/**
 * @param {string} line
 * @returns {RootDfStats | null}
 */
export function parseDfBytesLine(line) {
  const parts = String(line ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const sizeBytes = Number(parts[0]);
  const usedBytes = Number(parts[1]);
  const availBytes = Number(parts[2]);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  if (!Number.isFinite(usedBytes) || usedBytes < 0) return null;
  if (!Number.isFinite(availBytes) || availBytes < 0) return null;
  return { sizeBytes, usedBytes, availBytes };
}

/**
 * @param {RootDfStats} df
 * @returns {number}
 */
export function rootUsedPercent(df) {
  return (df.usedBytes / df.sizeBytes) * 100;
}

/**
 * @param {RootDfStats} df
 * @param {number} [thresholdPct]
 * @returns {boolean}
 */
export function needsRootExpansion(df, thresholdPct = DEFAULT_MAX_USED_PERCENT) {
  return rootUsedPercent(df) > thresholdPct;
}

/**
 * @param {RootDfStats} df
 * @param {number} [thresholdPct]
 * @returns {boolean}
 */
export function stillNeedsRootExpansion(df, thresholdPct = DEFAULT_MAX_USED_PERCENT) {
  return rootUsedPercent(df) >= thresholdPct;
}

/**
 * @param {RootDfStats} df
 * @param {number} thresholdPct
 * @param {number} incrementGb
 * @returns {number}
 */
export function expansionStepsNeeded(df, thresholdPct, incrementGb) {
  let sizeBytes = df.sizeBytes;
  const usedBytes = df.usedBytes;
  const incrementBytes = incrementGb * GIB;
  let steps = 0;
  if (rootUsedPercent({ sizeBytes, usedBytes, availBytes: sizeBytes - usedBytes }) <= thresholdPct) {
    return 0;
  }
  while (stillNeedsRootExpansion({ sizeBytes, usedBytes, availBytes: sizeBytes - usedBytes }, thresholdPct)) {
    if (steps >= MAX_EXPANSION_STEPS) break;
    sizeBytes += incrementBytes;
    steps += 1;
  }
  return steps;
}

/**
 * @param {RootDfStats} df
 * @param {number} thresholdPct
 * @param {number} incrementGb
 * @returns {{ steps: number; targetSizeGb: number }}
 */
export function nextExpansionPlan(df, thresholdPct, incrementGb) {
  const steps = expansionStepsNeeded(df, thresholdPct, incrementGb);
  const targetSizeGb =
    Math.round(((df.sizeBytes + steps * incrementGb * GIB) / GIB) * 10) / 10;
  return { steps, targetSizeGb };
}

/**
 * @param {string} name
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function shouldSkipGuestByName(name, patterns = DEFAULT_SKIP_NAME_PATTERNS) {
  const lower = String(name ?? "").trim().toLowerCase();
  if (!lower) return false;
  for (const pattern of patterns) {
    const p = String(pattern ?? "").trim().toLowerCase();
    if (p && lower.includes(p)) return true;
  }
  return false;
}

/**
 * @param {string} guestName
 * @param {string} systemId
 * @returns {boolean}
 */
export function guestNameMatchesSystemId(guestName, systemId) {
  const g = String(guestName ?? "").trim().toLowerCase();
  const s = String(systemId ?? "").trim().toLowerCase();
  if (!g || !s) return false;
  if (g === s) return true;
  if (g === s.replace(/^vm-/, "")) return true;
  if (`vm-${g}` === s) return true;
  return false;
}

/**
 * @param {string} configText
 * @returns {string | null}
 */
export function parseQemuBootDiskFromConfig(configText) {
  const text = String(configText ?? "");
  const bootMatch = text.match(/^boot:\s*order=([^\n]+)/m);
  if (bootMatch) {
    const first = bootMatch[1].split(/[;,]/)[0]?.trim();
    if (first) return first;
  }
  if (/^scsi0:/m.test(text)) return "scsi0";
  if (/^virtio0:/m.test(text)) return "virtio0";
  if (/^sata0:/m.test(text)) return "sata0";
  return null;
}

/**
 * @param {unknown} cfg
 * @returns {{ maxUsedPercent: number; incrementGb: number; skipNamePatterns: string[] }}
 */
export function guestRootdiskOptionsFromConfig(cfg) {
  /** @type {{ maxUsedPercent: number; incrementGb: number; skipNamePatterns: string[] }} */
  const defaults = {
    maxUsedPercent: DEFAULT_MAX_USED_PERCENT,
    incrementGb: DEFAULT_INCREMENT_GB,
    skipNamePatterns: [...DEFAULT_SKIP_NAME_PATTERNS],
  };
  if (!isProxmoxConfigObject(cfg)) return defaults;
  const provision = cfg.provision;
  if (!isObject(provision)) return defaults;
  const gr = provision.guest_rootdisk;
  if (!isObject(gr)) return defaults;

  const maxRaw = gr.max_used_percent;
  const maxN = typeof maxRaw === "number" ? maxRaw : Number(maxRaw);
  if (Number.isFinite(maxN) && maxN > 0 && maxN < 100) {
    defaults.maxUsedPercent = maxN;
  }

  const incRaw = gr.increment_gb;
  const incN = typeof incRaw === "number" ? incRaw : Number(incRaw);
  if (Number.isFinite(incN) && incN > 0) {
    defaults.incrementGb = incN;
  }

  if (Array.isArray(gr.skip_name_patterns) && gr.skip_name_patterns.length) {
    defaults.skipNamePatterns = gr.skip_name_patterns
      .filter((p) => typeof p === "string" && p.trim())
      .map((p) => String(p).trim());
  }

  return defaults;
}

/**
 * @param {Record<string, string>} [flags]
 * @param {{ maxUsedPercent: number; incrementGb: number; skipNamePatterns: string[] }} configOpts
 */
export function resolveGuestRootdiskRunOptions(flags, configOpts) {
  let maxUsedPercent = configOpts.maxUsedPercent;
  let incrementGb = configOpts.incrementGb;

  if (flags) {
    const th = flags["guest-rootfs-threshold"] ?? flags.guest_rootfs_threshold;
    if (th !== undefined) {
      const n = Number(th);
      if (Number.isFinite(n) && n > 0 && n < 100) maxUsedPercent = n;
    }
    const inc = flags["guest-rootfs-increment-gb"] ?? flags.guest_rootfs_increment_gb;
    if (inc !== undefined) {
      const n = Number(inc);
      if (Number.isFinite(n) && n > 0) incrementGb = n;
    }
  }

  return {
    maxUsedPercent,
    incrementGb,
    skipNamePatterns: configOpts.skipNamePatterns,
  };
}

/**
 * @param {string} publicRoot
 * @param {NodeJS.ProcessEnv} env
 * @returns {Map<string, { host: string; user: string }>}
 */
export function buildGuestSshMapFromInventory(publicRoot, env) {
  /** @type {Map<string, { host: string; user: string }>} */
  const map = new Map();
  /** @type {string[]} */
  const dirs = [];
  const priv = hdcPrivateRoot(publicRoot, env);
  if (priv) dirs.push(join(priv, "inventory", "manual", "systems"));
  dirs.push(join(publicRoot, "inventory", "manual", "systems"));

  /** @type {Set<string>} */
  const seenIds = new Set();

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("_"));
    } catch {
      continue;
    }
    for (const file of names) {
      const systemId = file.replace(/\.json$/, "");
      if (seenIds.has(systemId)) continue;
      seenIds.add(systemId);
      const system = loadManualSystemSidecar(publicRoot, systemId);
      if (!system) continue;
      const ip = primaryIpFromSystem(system);
      if (!ip) continue;
      const access = isObject(system.access) ? system.access : {};
      const nodes = Array.isArray(access.nodes) ? access.nodes : [];
      const first = nodes[0];
      let user = resolveGuestSshUser(undefined, env);
      if (isObject(first) && typeof first.ssh === "string") {
        const parsed = parseSshUrl(first.ssh);
        if (parsed?.user) user = parsed.user;
      }
      const host = ip.split("/")[0];
      const keys = [
        systemId.toLowerCase(),
        systemId.replace(/^vm-/, "").toLowerCase(),
      ];
      for (const key of keys) {
        if (key && !map.has(key)) map.set(key, { host, user });
      }
    }
  }

  return map;
}

/**
 * @param {Map<string, { host: string; user: string }>} inventoryMap
 * @param {string} guestName
 * @returns {{ host: string; user: string } | null}
 */
export function resolveInventorySshForGuestName(inventoryMap, guestName) {
  const g = String(guestName ?? "").trim().toLowerCase();
  if (!g) return null;
  return inventoryMap.get(g) ?? inventoryMap.get(g.replace(/^vm-/, "")) ?? null;
}

/**
 * @param {unknown} cfg
 * @param {NodeJS.ProcessEnv} env
 * @returns {Map<string, { user: string; host: string; hostId: string }>}
 */
export function buildPveNodeSshMap(cfg, env) {
  /** @type {Map<string, { user: string; host: string; hostId: string }>} */
  const map = new Map();
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: "",
    configRel: "",
    onSkip: () => {},
  });
  for (const members of byCluster.values()) {
    for (const m of members) {
      const ssh = typeof m.host.ssh === "string" ? m.host.ssh : "";
      const parsed = parseSshUrl(ssh);
      if (!parsed?.host) continue;
      const user =
        parsed.user ??
        (typeof env.HDC_PROXMOX_SSH_USER === "string" && env.HDC_PROXMOX_SSH_USER.trim()
          ? env.HDC_PROXMOX_SSH_USER.trim()
          : "root");
      map.set(m.pveNode, { user, host: parsed.host, hostId: m.id });
    }
  }
  return map;
}

/**
 * @param {Record<string, unknown>[]} storageRows
 * @param {string} pveNode
 * @returns {boolean}
 */
export function nodeStorageCriticallyFull(storageRows, pveNode) {
  const pools = storagePoolsForNode(storageRows, pveNode);
  for (const p of pools) {
    if (p.usedPercent !== null && p.usedPercent >= CRIT_PCT) {
      if (p.type === "lvmthin" || p.type === "dir" || p.type === "zfspool" || p.type === "rbd") {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {object} opts
 * @param {"lxc" | "qemu"} opts.type
 * @param {number} opts.vmid
 * @param {{ user: string; host: string }} opts.nodeSsh
 * @param {"lxc" | "qemu-agent" | "ssh"} opts.method
 * @param {{ user: string; host: string } | null} [opts.guestSsh]
 * @returns {{ ok: boolean; df: RootDfStats | null; raw?: string; error?: string }}
 */
export function probeGuestRootDf(opts) {
  const { type, vmid, nodeSsh, method, guestSsh = null } = opts;
  let r;
  if (type === "lxc") {
    r = pctExec(nodeSsh.user, nodeSsh.host, vmid, ROOT_DF_SCRIPT, { capture: true });
  } else if (method === "qemu-agent") {
    r = qemuGuestExec(nodeSsh.user, nodeSsh.host, vmid, ROOT_DF_SCRIPT, { capture: true });
  } else if (method === "ssh" && guestSsh) {
    const escaped = ROOT_DF_SCRIPT.replace(/'/g, `'\\''`);
    r = sshRemote(guestSsh.user, guestSsh.host, `bash -lc '${escaped}'`, { capture: true });
  } else {
    return { ok: false, df: null, error: "no probe method" };
  }

  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, df: null, error: detail };
  }

  const df = parseDfBytesLine(r.stdout);
  if (!df) {
    return { ok: false, df: null, raw: r.stdout.trim(), error: "could not parse df output" };
  }
  return { ok: true, df, raw: r.stdout.trim() };
}

/**
 * @param {object} opts
 * @param {"lxc" | "qemu"} opts.type
 * @param {number} opts.vmid
 * @param {{ user: string; host: string }} opts.nodeSsh
 * @param {number} opts.incrementGb
 * @param {string} [opts.bootDisk]
 * @returns {{ ok: boolean; message?: string }}
 */
export function resizeGuestRootOnHypervisor(opts) {
  const { type, vmid, nodeSsh, incrementGb, bootDisk = "scsi0" } = opts;
  const sizeArg = `+${incrementGb}G`;
  const remote =
    type === "lxc"
      ? `pct resize ${vmid} rootfs ${sizeArg}`
      : `qm resize ${vmid} ${bootDisk} ${sizeArg}`;
  const r = sshRemote(nodeSsh.user, nodeSsh.host, remote, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, message: detail };
  }
  return { ok: true };
}

/**
 * @param {object} opts
 * @param {"lxc" | "qemu"} opts.type
 * @param {number} opts.vmid
 * @param {{ user: string; host: string }} opts.nodeSsh
 * @param {"lxc" | "qemu-agent" | "ssh"} opts.method
 * @param {{ user: string; host: string } | null} [opts.guestSsh]
 * @returns {{ ok: boolean; message?: string; df?: string }}
 */
export function growGuestRootFilesystem(opts) {
  const { type, vmid, nodeSsh, method, guestSsh = null } = opts;
  const script = growRootFilesystemScript();
  let r;
  if (type === "lxc") {
    r = pctExec(nodeSsh.user, nodeSsh.host, vmid, script, { capture: true });
  } else if (method === "qemu-agent") {
    r = qemuGuestExec(nodeSsh.user, nodeSsh.host, vmid, script, { capture: true });
  } else if (method === "ssh" && guestSsh) {
    const escaped = script.replace(/'/g, `'\\''`);
    r = sshRemote(guestSsh.user, guestSsh.host, `bash -lc '${escaped}'`, { capture: true });
  } else {
    return { ok: false, message: "no grow method" };
  }

  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, message: detail };
  }
  const dfLine = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  return { ok: true, df: dfLine };
}

/**
 * @param {object} opts
 * @param {{ user: string; host: string }} opts.nodeSsh
 * @param {number} opts.vmid
 * @returns {Promise<{ ok: boolean; bootDisk: string | null; error?: string }>}
 */
export async function resolveQemuBootDisk(opts) {
  const { nodeSsh, vmid } = opts;
  const r = sshRemote(nodeSsh.user, nodeSsh.host, `qm config ${vmid}`, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, bootDisk: null, error: detail };
  }
  const bootDisk = parseQemuBootDiskFromConfig(r.stdout);
  if (!bootDisk) {
    return { ok: false, bootDisk: null, error: "no boot disk in qm config" };
  }
  return { ok: true, bootDisk };
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.row
 * @param {Map<string, { user: string; host: string; hostId: string }>} opts.nodeSshMap
 * @param {Map<string, { host: string; user: string }>} opts.inventorySshMap
 * @param {number} opts.maxUsedPercent
 * @param {number} opts.incrementGb
 * @param {string[]} opts.skipNamePatterns
 * @param {Record<string, unknown>[]} opts.storageRows
 * @param {boolean} opts.dryRun
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @returns {Promise<GuestRootdiskRow>}
 */
export async function maintainGuestRootdisk(opts) {
  const {
    row,
    nodeSshMap,
    inventorySshMap,
    maxUsedPercent,
    incrementGb,
    skipNamePatterns,
    storageRows,
    dryRun,
    log,
    warn,
  } = opts;

  const guest = guestConfigFromResource(row);
  if (!guest) {
    return {
      vmid: 0,
      name: "?",
      type: "?",
      node: "?",
      status: "?",
      outcome: "skipped",
      message: "invalid guest resource",
    };
  }

  const status = typeof row.status === "string" ? row.status.trim() : "unknown";
  /** @type {GuestRootdiskRow} */
  const base = {
    vmid: guest.vmid,
    name: guest.name,
    type: guest.type,
    node: guest.node,
    status,
    outcome: "ok",
    expanded_gb: 0,
  };

  if (status !== "running") {
    return { ...base, outcome: "skipped", message: "guest not running" };
  }

  if (shouldSkipGuestByName(guest.name, skipNamePatterns)) {
    return { ...base, outcome: "skipped", message: "name matches skip pattern" };
  }

  const nodeSsh = nodeSshMap.get(guest.node);
  if (!nodeSsh) {
    return { ...base, outcome: "skipped", message: `no SSH target for node ${guest.node}` };
  }

  const typ = guest.type === "lxc" ? "lxc" : "qemu";
  /** @type {"lxc" | "qemu-agent" | "ssh"} */
  let method = typ === "lxc" ? "lxc" : "qemu-agent";
  /** @type {{ user: string; host: string } | null} */
  let guestSsh = null;

  if (typ === "qemu") {
    const agentProbe = probeGuestRootDf({
      type: "qemu",
      vmid: guest.vmid,
      nodeSsh,
      method: "qemu-agent",
    });
    if (agentProbe.ok) {
      method = "qemu-agent";
    } else {
      guestSsh = resolveInventorySshForGuestName(inventorySshMap, guest.name);
      if (!guestSsh) {
        return {
          ...base,
          outcome: "skipped",
          message: `df probe failed (guest agent) and no inventory SSH: ${agentProbe.error ?? "unknown"}`,
        };
      }
      method = "ssh";
    }
  }

  let probe = probeGuestRootDf({
    type: typ,
    vmid: guest.vmid,
    nodeSsh,
    method,
    guestSsh,
  });
  if (!probe.ok || !probe.df) {
    return {
      ...base,
      outcome: "skipped",
      message: probe.error ?? "df probe failed",
    };
  }

  const beforePct = Math.round(rootUsedPercent(probe.df) * 10) / 10;
  base.before_used_percent = beforePct;
  base.method = method;

  if (!needsRootExpansion(probe.df, maxUsedPercent)) {
    base.after_used_percent = beforePct;
    return { ...base, outcome: "ok", message: "root usage within threshold" };
  }

  if (nodeStorageCriticallyFull(storageRows, guest.node)) {
    warn(
      `guest rootdisk: vmid ${guest.vmid} ${guest.name} — node ${guest.node} storage pool at critical utilization (>=${CRIT_PCT}%) — skip expand`,
    );
    return {
      ...base,
      outcome: "skipped",
      message: `node storage critically full (>=${CRIT_PCT}%)`,
    };
  }

  let bootDisk = "scsi0";
  if (typ === "qemu") {
    const boot = await resolveQemuBootDisk({ nodeSsh, vmid: guest.vmid });
    if (!boot.ok || !boot.bootDisk) {
      return {
        ...base,
        outcome: "failed",
        message: boot.error ?? "could not resolve QEMU boot disk",
      };
    }
    bootDisk = boot.bootDisk;
  }

  const plan = nextExpansionPlan(probe.df, maxUsedPercent, incrementGb);
  if (dryRun) {
    log(
      `[dry-run] vmid ${guest.vmid} ${guest.name}: would expand +${plan.steps * incrementGb}G (${plan.steps}×${incrementGb}G) from ${beforePct}% used`,
    );
    return {
      ...base,
      outcome: "dry_run",
      expanded_gb: plan.steps * incrementGb,
      after_used_percent: null,
      message: `would expand ${plan.steps} step(s)`,
    };
  }

  let expandedGb = 0;
  let steps = 0;
  let currentDf = probe.df;

  while (stillNeedsRootExpansion(currentDf, maxUsedPercent) && steps < MAX_EXPANSION_STEPS) {
    log(`vmid ${guest.vmid} ${guest.name}: expanding root +${incrementGb}G (step ${steps + 1}) …`);
    const resize = resizeGuestRootOnHypervisor({
      type: typ,
      vmid: guest.vmid,
      nodeSsh,
      incrementGb,
      bootDisk,
    });
    if (!resize.ok) {
      return {
        ...base,
        outcome: "failed",
        expanded_gb: expandedGb,
        after_used_percent: Math.round(rootUsedPercent(currentDf) * 10) / 10,
        message: `hypervisor resize failed: ${resize.message}`,
      };
    }

    const grow = growGuestRootFilesystem({
      type: typ,
      vmid: guest.vmid,
      nodeSsh,
      method,
      guestSsh,
    });
    if (!grow.ok) {
      return {
        ...base,
        outcome: "failed",
        expanded_gb: expandedGb,
        after_used_percent: Math.round(rootUsedPercent(currentDf) * 10) / 10,
        message: `guest grow failed: ${grow.message}`,
      };
    }

    expandedGb += incrementGb;
    steps += 1;

    const again = probeGuestRootDf({
      type: typ,
      vmid: guest.vmid,
      nodeSsh,
      method,
      guestSsh,
    });
    if (!again.ok || !again.df) {
      return {
        ...base,
        outcome: "failed",
        expanded_gb: expandedGb,
        message: `post-expand df probe failed: ${again.error ?? "unknown"}`,
      };
    }
    currentDf = again.df;
  }

  const afterPct = Math.round(rootUsedPercent(currentDf) * 10) / 10;
  if (stillNeedsRootExpansion(currentDf, maxUsedPercent)) {
    return {
      ...base,
      outcome: "failed",
      expanded_gb: expandedGb,
      after_used_percent: afterPct,
      message: `still above ${maxUsedPercent}% after ${steps} expansion step(s)`,
    };
  }

  log(`vmid ${guest.vmid} ${guest.name}: expanded +${expandedGb}G (${beforePct}% → ${afterPct}% used)`);
  return {
    ...base,
    outcome: "expanded",
    expanded_gb: expandedGb,
    after_used_percent: afterPct,
    message: `expanded +${expandedGb}G`,
  };
}

/**
 * @param {GuestRootdiskRow[]} guests
 * @returns {string[]}
 */
export function renderGuestRootdiskMarkdown(guests) {
  /** @type {string[]} */
  const lines = ["## Guest root disk expansion", ""];
  if (!guests.length) {
    lines.push("_No guests evaluated._", "");
    return lines;
  }
  lines.push(
    "| vmid | name | type | node | before % | after % | +GiB | method | status |",
    "| ---: | --- | --- | --- | ---: | ---: | ---: | --- | --- |",
  );
  for (const g of guests) {
    const before = g.before_used_percent ?? "—";
    const after = g.after_used_percent ?? "—";
    const expanded = g.expanded_gb ?? 0;
    const method = g.method ?? "—";
    const status = g.outcome + (g.message ? `: ${g.message}` : "");
    lines.push(
      `| ${g.vmid} | ${g.name} | ${g.type} | ${g.node} | ${before} | ${after} | ${expanded} | ${method} | ${status} |`,
    );
  }
  lines.push("");
  return lines;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} [opts.log]
 * @param {(line: string) => void} [opts.warn]
 * @param {boolean} [opts.dryRun]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 * @param {Record<string, string>} [opts.flags]
 * @returns {Promise<GuestRootdiskReportData>}
 */
export async function runProxmoxGuestRootdiskMaintain(opts) {
  const {
    clumpRoot,
    log = () => {},
    warn = () => {},
    dryRun = false,
    env = process.env,
    vault,
    flags = {},
  } = opts;

  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "Guest root disk");
  if (!loaded) {
    return {
      ok: true,
      warnings: [],
      guests: [],
      max_used_percent: DEFAULT_MAX_USED_PERCENT,
      increment_gb: DEFAULT_INCREMENT_GB,
    };
  }

  const cfg = loaded.data;
  const configOpts = guestRootdiskOptionsFromConfig(cfg);
  const runOpts = resolveGuestRootdiskRunOptions(flags, configOpts);
  const nodeSshMap = buildPveNodeSshMap(cfg, env);
  const inventorySshMap = buildGuestSshMapFromInventory(repoRoot(), env);

  /** @type {string[]} */
  const warnings = [];
  const warnPush = (line) => {
    warnings.push(line);
    warn(line);
  };

  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: loaded.path,
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: (id, reason) =>
      warnPush(`Guest rootdisk: skip host ${JSON.stringify(id)} (${reason})`),
  });

  /** @type {GuestRootdiskRow[]} */
  const allGuests = [];
  let ok = true;

  log(
    `guest rootdisk: threshold ${runOpts.maxUsedPercent}% used, increment ${runOpts.incrementGb}G${dryRun ? " [dry-run]" : ""}`,
  );

  for (const [clusterKey, members] of byCluster) {
    if (!members?.length) continue;

    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn: warnPush,
      verifyPaths: PROXMOX_MAINTAIN_VERIFY_PATHS,
    });
    if (!auth) {
      ok = false;
      warnPush(`Guest rootdisk: skipping cluster ${JSON.stringify(clusterKey)} — no API auth.`);
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    let resourceRows = [];
    try {
      resourceRows = await fetchClusterVmResources(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
      );
    } catch (e) {
      ok = false;
      warnPush(
        `Guest rootdisk: cluster ${JSON.stringify(clusterKey)} VM list failed: ${/** @type {Error} */ (e).message || e}`,
      );
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    let storageRows = [];
    try {
      storageRows = await fetchPveStorageList(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
      );
    } catch (e) {
      warnPush(
        `Guest rootdisk: cluster ${JSON.stringify(clusterKey)} storage list failed: ${/** @type {Error} */ (e).message || e}`,
      );
    }

    for (const row of resourceRows) {
      if (!isProxmoxConfigObject(row) || !isGuestResource(row)) continue;
      try {
        const result = await maintainGuestRootdisk({
          row,
          nodeSshMap,
          inventorySshMap,
          maxUsedPercent: runOpts.maxUsedPercent,
          incrementGb: runOpts.incrementGb,
          skipNamePatterns: runOpts.skipNamePatterns,
          storageRows,
          dryRun,
          log,
          warn: warnPush,
        });
        allGuests.push(result);
        if (result.outcome === "failed") ok = false;
      } catch (e) {
        ok = false;
        const guest = guestConfigFromResource(row);
        allGuests.push({
          vmid: guest?.vmid ?? 0,
          name: guest?.name ?? "?",
          type: guest?.type ?? "?",
          node: guest?.node ?? "?",
          status: typeof row.status === "string" ? row.status : "?",
          outcome: "failed",
          message: String(/** @type {Error} */ (e).message || e),
        });
      }
    }
  }

  allGuests.sort((a, b) => a.vmid - b.vmid);

  return {
    ok,
    warnings,
    guests: allGuests,
    max_used_percent: runOpts.maxUsedPercent,
    increment_gb: runOpts.incrementGb,
  };
}
