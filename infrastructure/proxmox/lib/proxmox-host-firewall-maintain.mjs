import { existsSync, readFileSync } from "node:fs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import os from "node:os";
import { join } from "node:path";

import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import { isProxmoxConfigObject, loadProxmoxHostsByCluster } from "./proxmox-config.mjs";
import { listProxmoxHypervisorSshTargets } from "./proxmox-host-os-maintain.mjs";
import {
  discoverLocalSshMaterial,
  shellSingleQuote,
  sshBashLc,
  sshReachableWithPubkey,
} from "hdc/cli/lib/ssh-host-access.mjs";

export const HDC_FIREWALL_MARKER_BEGIN = "# --- hdc-maintain: host-access begin ---";
export const HDC_FIREWALL_MARKER_END = "# --- hdc-maintain: host-access end ---";

const CLUSTER_FW_PATH = "/etc/pve/firewall/cluster.fw";

/** @type {string[]} */
const DEFAULT_ALLOWED_SOURCE_CIDRS = [
  "192.0.2.0/24",
  "198.51.100.0/24",
  "198.51.101.0/24",
];

/**
 * @param {unknown} cfg
 */
export function hostFirewallMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return true;
  const hostFirewall = provision.host_firewall;
  if (!isProxmoxConfigObject(hostFirewall)) return true;
  return hostFirewall.enabled !== false && hostFirewall.enabled !== 0;
}

/**
 * @param {unknown} cfg
 * @returns {string[]}
 */
export function hostFirewallAllowedCidrsFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return [...DEFAULT_ALLOWED_SOURCE_CIDRS];
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return [...DEFAULT_ALLOWED_SOURCE_CIDRS];
  const hostFirewall = provision.host_firewall;
  if (!isProxmoxConfigObject(hostFirewall)) return [...DEFAULT_ALLOWED_SOURCE_CIDRS];
  const raw = hostFirewall.allowed_source_cidrs;
  if (!Array.isArray(raw) || !raw.length) return [...DEFAULT_ALLOWED_SOURCE_CIDRS];
  /** @type {string[]} */
  const out = [];
  for (const c of raw) {
    if (typeof c === "string" && c.trim()) out.push(c.trim());
  }
  return out.length ? out : [...DEFAULT_ALLOWED_SOURCE_CIDRS];
}

/**
 * @param {unknown} cfg
 */
function hostFirewallPortsFromConfig(cfg) {
  let sshPort = 22;
  let webPort = 8006;
  if (!isProxmoxConfigObject(cfg)) return { sshPort, webPort };
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return { sshPort, webPort };
  const hostFirewall = provision.host_firewall;
  if (!isProxmoxConfigObject(hostFirewall)) return { sshPort, webPort };
  const sp = hostFirewall.ssh_port;
  const wp = hostFirewall.web_port;
  if (typeof sp === "number" && Number.isFinite(sp) && sp > 0 && sp <= 65535) sshPort = Math.round(sp);
  if (typeof wp === "number" && Number.isFinite(wp) && wp > 0 && wp <= 65535) webPort = Math.round(wp);
  return { sshPort, webPort };
}

/**
 * UniFi-style gateway CIDR (192.0.2.0/24) → network CIDR for Proxmox -source.
 * @param {string} cidr
 */
export function normalizeSourceCidr(cidr) {
  const s = String(cidr ?? "").trim();
  const m = /^(\d+\.\d+\.\d+)\.1\/(\d+)$/.exec(s);
  if (m) return `${m[1]}.0/${m[2]}`;
  return s;
}

/**
 * @param {string} ip
 * @returns {number | null}
 */
export function parseIpv4ToUint32(ip) {
  const parts = String(ip ?? "")
    .trim()
    .split(".");
  if (parts.length !== 4) return null;
  /** @type {number[]} */
  const nums = [];
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

/**
 * @param {string} cidr
 * @returns {{ network: number, mask: number } | null}
 */
export function parseIpv4Cidr(cidr) {
  const normalized = normalizeSourceCidr(cidr);
  const slash = normalized.indexOf("/");
  if (slash < 1) return null;
  const ipPart = normalized.slice(0, slash);
  const prefix = Number.parseInt(normalized.slice(slash + 1), 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;
  const ipNum = parseIpv4ToUint32(ipPart);
  if (ipNum === null) return null;
  const mask = prefix === 0 ? 0 : ((~0 << (32 - prefix)) >>> 0);
  return { network: (ipNum & mask) >>> 0, mask };
}

/**
 * @param {string} ip
 * @param {string} cidr
 */
export function ipv4InCidr(ip, cidr) {
  const ipNum = parseIpv4ToUint32(ip);
  const net = parseIpv4Cidr(cidr);
  if (ipNum === null || !net) return false;
  return ((ipNum & net.mask) >>> 0) === net.network;
}

/**
 * @returns {string[]}
 */
export function localIpv4Addresses() {
  /** @type {string[]} */
  const ips = [];
  const ifs = os.networkInterfaces();
  if (!ifs) return ips;
  for (const name of Object.keys(ifs)) {
    const addrs = ifs[name];
    if (!addrs) continue;
    for (const a of addrs) {
      if (!a || a.internal) continue;
      if (a.family === "IPv4" || a.family === 4) {
        const addr = String(a.address).trim();
        if (addr) ips.push(addr);
      }
    }
  }
  return ips;
}

/**
 * @param {{ sshClientIp?: string | null, localIps?: string[], allowedCidrs: string[] }} opts
 * @returns {{ allowed: boolean, checkedIps: string[] }}
 */
export function resolveMaintainSourceAllowed(opts) {
  const { sshClientIp, localIps = [], allowedCidrs } = opts;
  const sshIp = typeof sshClientIp === "string" ? sshClientIp.trim() : "";

  if (sshIp) {
    const allowed = allowedCidrs.some((c) => ipv4InCidr(sshIp, c));
    return { allowed, checkedIps: [sshIp] };
  }

  const locals = localIps.filter((ip) => typeof ip === "string" && ip.trim()).map((ip) => ip.trim());
  if (!locals.length) return { allowed: false, checkedIps: [] };
  const allowed = locals.some((ip) => allowedCidrs.some((c) => ipv4InCidr(ip, c)));
  return { allowed, checkedIps: locals };
}

/**
 * @param {{ cidrs: string[], sshPort: number, webPort: number }} opts
 */
export function buildHostFirewallHdcSection(opts) {
  const { cidrs, sshPort, webPort } = opts;
  const sourceList = cidrs.map((c) => normalizeSourceCidr(c)).join(",");
  return [
    HDC_FIREWALL_MARKER_BEGIN,
    "[OPTIONS]",
    "enable: 1",
    "",
    "[RULES]",
    `IN SSH(ACCEPT) -source ${sourceList}`,
    `IN ACCEPT -p tcp -dport ${webPort} -source ${sourceList}`,
    `IN DROP -p tcp -dport ${sshPort}`,
    `IN DROP -p tcp -dport ${webPort}`,
    HDC_FIREWALL_MARKER_END,
    "",
  ].join("\n");
}

/**
 * @param {string} existing
 * @param {string} section
 */
export function mergeHdcFirewallSection(existing, section) {
  const begin = existing.indexOf(HDC_FIREWALL_MARKER_BEGIN);
  const end = existing.indexOf(HDC_FIREWALL_MARKER_END);
  const sectionTrimmed = section.endsWith("\n") ? section : `${section}\n`;

  if (begin >= 0 && end >= 0 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + HDC_FIREWALL_MARKER_END.length);
    return `${before}${sectionTrimmed}${after}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  const base = existing.trimEnd();
  if (!base) return sectionTrimmed;
  return `${base}\n\n${sectionTrimmed}`;
}

/**
 * @param {string} pveNode
 */
export function hostFirewallPathForNode(pveNode) {
  return `/etc/pve/nodes/${pveNode}/host.fw`;
}

/**
 * @param {string} path
 */
function buildReadFirewallScript(path) {
  return `if [ -f ${shellSingleQuote(path)} ]; then cat ${shellSingleQuote(path)}; fi`;
}

/**
 * @param {string} path
 * @param {string} content
 */
function buildWriteFirewallScript(path, content) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  return `
set -euo pipefail
path=${shellSingleQuote(path)}
tmp=$(mktemp)
echo ${shellSingleQuote(b64)} | base64 -d > "$tmp"
if [ -f "$path" ] && cmp -s "$path" "$tmp"; then
  rm -f "$tmp"
  echo "unchanged"
  exit 0
fi
install -m 0644 "$tmp" "$path"
rm -f "$tmp"
pve-firewall compile
pve-firewall restart
echo "updated"
`.trim();
}

/**
 * @param {{ id: string; user: string; host: string; clusterId: string | null }} target
 * @param {typeof import("node:child_process").spawnSync} spawnSync
 * @param {NodeJS.ProcessEnv} env
 * @param {{ privateKey: string; certificateFile?: string }[]} identities
 * @returns {Promise<string | null>}
 */
async function readSshClientIp(target, spawnSync, env, identities) {
  const r = sshBashLc(target, `echo "$SSH_CLIENT" | awk '{print $1}'`, {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs: 30_000,
  });
  if (r.status !== 0) return null;
  const ip = `${r.stdout ?? ""}`.trim();
  return ip || null;
}

/**
 * @param {{ id: string; user: string; host: string; clusterId: string | null }} target
 * @param {string} fwPath
 * @param {typeof import("node:child_process").spawnSync} spawnSync
 * @param {NodeJS.ProcessEnv} env
 * @param {{ privateKey: string; certificateFile?: string }[]} identities
 */
function readRemoteFirewallFile(target, fwPath, spawnSync, env, identities) {
  return sshBashLc(target, buildReadFirewallScript(fwPath), {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs: 60_000,
  });
}

/**
 * @typedef {object} FirewallMaintainJob
 * @property {string} clusterKey
 * @property {string | null} clusterId
 * @property {"cluster" | "host"} mode
 * @property {string} fwPath
 * @property {{ id: string; user: string; host: string; clusterId: string | null }} sshTarget
 * @property {string[]} memberIds
 */

/**
 * @param {unknown} cfg
 * @param {NodeJS.ProcessEnv} env
 * @returns {FirewallMaintainJob[]}
 */
export function hostFirewallJobsFromConfig(cfg, env) {
  /** @type {FirewallMaintainJob[]} */
  const jobs = [];
  if (!isProxmoxConfigObject(cfg)) return jobs;

  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: "",
    configRel: "",
    onSkip: () => {},
  });
  const targets = listProxmoxHypervisorSshTargets(cfg, env);
  const targetById = new Map(targets.map((t) => [t.id, t]));

  for (const [clusterKey, members] of byCluster) {
    if (!members.length) continue;
    const reachable = members
      .map((m) => targetById.get(m.id))
      .filter((t) => t !== undefined);
    if (!reachable.length) continue;

    if (members.length >= 2) {
      jobs.push({
        clusterKey,
        clusterId: members[0].clusterId,
        mode: "cluster",
        fwPath: CLUSTER_FW_PATH,
        sshTarget: reachable[0],
        memberIds: members.map((m) => m.id),
      });
    } else {
      for (const m of members) {
        const t = targetById.get(m.id);
        if (!t) continue;
        jobs.push({
          clusterKey,
          clusterId: m.clusterId,
          mode: "host",
          fwPath: hostFirewallPathForNode(m.pveNode),
          sshTarget: t,
          memberIds: [m.id],
        });
      }
    }
  }

  return jobs;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 */
export async function runProxmoxHostFirewallMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, env, spawnSync } = opts;
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "Host firewall maintain");
  if (!loaded) {
    return { ok: true, skipped: false, results: [] };
  }
  const cfg = loaded.data;

  if (!hostFirewallMaintainEnabledFromConfig(cfg)) {
    log("host firewall maintain: disabled in provision.host_firewall.enabled — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  const allowedCidrs = hostFirewallAllowedCidrsFromConfig(cfg);
  const normalizedList = allowedCidrs.map((c) => normalizeSourceCidr(c)).join(", ");
  const { sshPort, webPort } = hostFirewallPortsFromConfig(cfg);
  const hdcSection = buildHostFirewallHdcSection({ cidrs: allowedCidrs, sshPort, webPort });

  const targets = listProxmoxHypervisorSshTargets(cfg, env);
  if (!targets.length) {
    warn("host firewall maintain: no clusters[].hosts[] with ssh:// URLs — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  const { identities } = discoverLocalSshMaterial();
  const jobs = hostFirewallJobsFromConfig(cfg, env);
  if (!jobs.length) {
    warn("host firewall maintain: no firewall jobs (all hosts down or missing SSH) — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  log(
    `host firewall maintain: ${jobs.length} target(s); allowed sources ${normalizedList}; SSH ${sshPort}, web ${webPort}${dryRun ? " [dry-run]" : ""}.`,
  );

  /** @type {string | null} */
  let sshClientIp = null;
  for (const t of targets) {
    if (!sshReachableWithPubkey(t, spawnSync, env, identities)) continue;
    sshClientIp = await readSshClientIp(t, spawnSync, env, identities);
    if (sshClientIp) break;
  }

  const gate = resolveMaintainSourceAllowed({
    sshClientIp,
    localIps: localIpv4Addresses(),
    allowedCidrs,
  });

  if (!gate.allowed) {
    const seen = gate.checkedIps.length ? gate.checkedIps.join(", ") : "(none)";
    warn(
      `host firewall: skipped — maintain source ${seen} not in allowed subnets (${normalizedList}). Re-run from an allowed LAN.`,
    );
    return {
      ok: true,
      skipped: true,
      reason: "source_not_allowed",
      sourceIps: gate.checkedIps,
      results: [],
    };
  }

  log(
    `host firewall: source allowed (${gate.checkedIps.join(", ")}) — proceeding${dryRun ? " (dry-run, no writes)" : ""}.`,
  );

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  for (const job of jobs) {
    const label =
      job.mode === "cluster"
        ? `cluster ${job.clusterId ?? job.clusterKey}`
        : job.sshTarget.id;
    /** @type {Record<string, unknown>} */
    const row = {
      clusterId: job.clusterId,
      hostId: job.mode === "host" ? job.sshTarget.id : null,
      memberIds: job.memberIds,
      path: job.fwPath,
      mode: job.mode,
    };

    if (!sshReachableWithPubkey(job.sshTarget, spawnSync, env, identities)) {
      ok = false;
      warn(`[${label}] SSH public-key auth failed — skip ${job.fwPath}.`);
      row.ok = false;
      row.error = "ssh unreachable";
      results.push(row);
      continue;
    }

    log(`[${label}] ${job.fwPath} …`);
    const readR = readRemoteFirewallFile(job.sshTarget, job.fwPath, spawnSync, env, identities);
    if (readR.status !== 0) {
      ok = false;
      const err = `${readR.stderr ?? ""}${readR.stdout ?? ""}`.trim() || `ssh exit ${readR.status ?? "?"}`;
      warn(`[${label}] read failed: ${err}`);
      row.ok = false;
      row.error = err;
      results.push(row);
      continue;
    }

    const existing = `${readR.stdout ?? ""}`;
    const merged = mergeHdcFirewallSection(existing, hdcSection);
    row.changed = merged !== existing;

    if (!row.changed) {
      log(`[${label}] ${job.fwPath} already up to date.`);
      row.ok = true;
      results.push(row);
      continue;
    }

    if (dryRun) {
      log(`[${label}] would update ${job.fwPath}.`);
      row.ok = true;
      results.push(row);
      continue;
    }

    const writeR = sshBashLc(job.sshTarget, buildWriteFirewallScript(job.fwPath, merged), {
      spawnSync,
      env,
      mode: "pubkey",
      identities,
      timeoutMs: 120_000,
    });
    if (writeR.status !== 0) {
      ok = false;
      const err = `${writeR.stderr ?? ""}${writeR.stdout ?? ""}`.trim() || `ssh exit ${writeR.status ?? "?"}`;
      warn(`[${label}] write failed: ${err}`);
      row.ok = false;
      row.error = err;
      results.push(row);
      continue;
    }

    const msg = `${writeR.stdout ?? ""}`.trim();
    log(`[${label}] ${job.fwPath} ${msg || "updated"}.`);
    row.ok = true;
    results.push(row);
  }

  return { ok, skipped: false, results };
}
