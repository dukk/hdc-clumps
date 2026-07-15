import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { servicesPackagesDir } from "hdc/package/clumps-root.mjs";

import { tryLoadClumpConfigFromClumpRoot } from "hdc/cli/lib/clump-config.mjs";
import { repoRoot as defaultRepoRoot } from "hdc/cli/paths.mjs";
import {
  hostFirewallAllowedCidrsFromConfig,
  normalizeSourceCidr,
  resolveMaintainSourceAllowed,
  localIpv4Addresses,
} from "./proxmox-host-firewall-maintain.mjs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { isProxmoxConfigObject } from "./proxmox-config.mjs";
import { listProxmoxHypervisorSshTargets } from "./proxmox-host-os-maintain.mjs";
import {
  discoverLocalSshMaterial,
  shellSingleQuote,
  sshBashLc,
  sshReachableWithPubkey,
} from "hdc/cli/lib/ssh-host-access.mjs";

export const HDC_GUEST_FW_MARKER_BEGIN = "# --- hdc-maintain: guest-access begin ---";
export const HDC_GUEST_FW_MARKER_END = "# --- hdc-maintain: guest-access end ---";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} cfg
 */
export function guestFirewallMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return false;
  const provision = cfg.provision;
  if (!isObject(provision)) return false;
  const gf = provision.guest_firewall;
  if (!isObject(gf)) return false;
  return gf.enabled !== false && gf.enabled !== 0;
}

/**
 * @param {unknown} cfg
 * @returns {string[]}
 */
export function guestFirewallAllowedCidrsFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return hostFirewallAllowedCidrsFromConfig(cfg);
  const provision = cfg.provision;
  if (!isObject(provision)) return hostFirewallAllowedCidrsFromConfig(cfg);
  const gf = provision.guest_firewall;
  if (!isObject(gf)) return hostFirewallAllowedCidrsFromConfig(cfg);
  const raw = gf.allowed_source_cidrs;
  if (Array.isArray(raw) && raw.length) {
    /** @type {string[]} */
    const out = [];
    for (const c of raw) {
      if (typeof c === "string" && c.trim()) out.push(c.trim());
    }
    if (out.length) return out;
  }
  return hostFirewallAllowedCidrsFromConfig(cfg);
}

/**
 * @param {unknown} cfg
 */
export function guestFirewallManageFromDeployments(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isObject(provision)) return true;
  const gf = provision.guest_firewall;
  if (!isObject(gf)) return true;
  return gf.manage_from_deployments !== false && gf.manage_from_deployments !== 0;
}

/**
 * @param {string} vmid
 */
export function guestFirewallPathForVmid(vmid) {
  return `/etc/pve/firewall/${vmid}.fw`;
}

/**
 * @param {{ cidrs: string[], extraRules?: string[] }} opts
 */
export function buildGuestFirewallHdcSection(opts) {
  const sourceList = opts.cidrs.map((c) => normalizeSourceCidr(c)).join(",");
  /** @type {string[]} */
  const rules = [`IN ACCEPT -source ${sourceList}`];
  if (Array.isArray(opts.extraRules)) {
    for (const r of opts.extraRules) {
      if (typeof r === "string" && r.trim()) rules.push(r.trim());
    }
  }
  rules.push("IN DROP");
  return [
    HDC_GUEST_FW_MARKER_BEGIN,
    "[OPTIONS]",
    "enable: 1",
    "policy_in: DROP",
    "policy_out: ACCEPT",
    "",
    "[RULES]",
    ...rules,
    HDC_GUEST_FW_MARKER_END,
    "",
  ].join("\n");
}

/**
 * @param {string} existing
 * @param {string} section
 */
export function mergeGuestFirewallSection(existing, section) {
  const begin = existing.indexOf(HDC_GUEST_FW_MARKER_BEGIN);
  const end = existing.indexOf(HDC_GUEST_FW_MARKER_END);
  const sectionTrimmed = section.endsWith("\n") ? section : `${section}\n`;

  if (begin >= 0 && end >= 0 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + HDC_GUEST_FW_MARKER_END.length);
    return `${before}${sectionTrimmed}${after}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  const base = existing.trimEnd();
  if (!base) return sectionTrimmed;
  return `${base}\n\n${sectionTrimmed}`;
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
 * @param {unknown} deployment
 * @returns {{ vmid: number; hostId: string; systemId: string } | null}
 */
export function vmidFromDeployment(deployment) {
  if (!isObject(deployment)) return null;
  const systemId = typeof deployment.system_id === "string" ? deployment.system_id.trim() : "";
  const px = isObject(deployment.proxmox) ? deployment.proxmox : null;
  if (!px) return null;
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  const lxc = isObject(px.lxc) ? px.lxc : null;
  const qemu = isObject(px.qemu) ? px.qemu : null;
  let vmid = null;
  if (lxc && typeof lxc.vmid === "number") vmid = lxc.vmid;
  if (qemu && typeof qemu.vmid === "number") vmid = qemu.vmid;
  if (vmid === null || !hostId) return null;
  return { vmid, hostId, systemId: systemId || String(vmid) };
}

/**
 * Collect vmids from all service clump configs.
 *
 * @param {string} root repo root
 */
export function collectGuestFirewallTargetsFromPackages(root) {
  /** @type {Map<string, { vmid: number; hostId: string; systemId: string }>} */
  const byVmid = new Map();
  const servicesDir = servicesPackagesDir();
  let entries = [];
  try {
    entries = readdirSync(servicesDir);
  } catch {
    return [...byVmid.values()];
  }
  for (const pkgId of entries) {
    const pkgRoot = join(servicesDir, pkgId);
    try {
      if (!statSync(pkgRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    const exampleRel = `clumps/services/${pkgId}/config.example.json`;
    const loaded = tryLoadClumpConfigFromClumpRoot(pkgRoot, { exampleRel });
    if (!loaded || !isObject(loaded.data)) continue;
    const deployments = loaded.data.deployments;
    if (!Array.isArray(deployments)) continue;
    for (const d of deployments) {
      const row = vmidFromDeployment(d);
      if (!row) continue;
      byVmid.set(String(row.vmid), row);
    }
  }
  return [...byVmid.values()];
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string} [opts.repoRoot]
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 */
export async function runProxmoxGuestFirewallMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, env, spawnSync } = opts;
  const root = opts.repoRoot || defaultRepoRoot();
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "Guest firewall maintain");
  if (!loaded) {
    return { ok: true, skipped: false, results: [] };
  }
  const cfg = loaded.data;

  if (!guestFirewallMaintainEnabledFromConfig(cfg)) {
    log("guest firewall maintain: disabled in provision.guest_firewall.enabled — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  if (!guestFirewallManageFromDeployments(cfg)) {
    log("guest firewall maintain: manage_from_deployments false — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  const allowedCidrs = guestFirewallAllowedCidrsFromConfig(cfg);
  const normalizedList = allowedCidrs.map((c) => normalizeSourceCidr(c)).join(", ");
  const hdcSection = buildGuestFirewallHdcSection({ cidrs: allowedCidrs });

  const targets = listProxmoxHypervisorSshTargets(cfg, env);
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const guests = collectGuestFirewallTargetsFromPackages(root);

  if (!guests.length) {
    warn("guest firewall maintain: no vmids found in service package deployments — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  log(
    `guest firewall maintain: ${guests.length} guest(s); allowed sources ${normalizedList}${dryRun ? " [dry-run]" : ""}.`,
  );

  const { identities } = discoverLocalSshMaterial();

  /** @type {string | null} */
  let sshClientIp = null;
  for (const t of targets) {
    if (!sshReachableWithPubkey(t, spawnSync, env, identities)) continue;
    const r = sshBashLc(t, `echo "$SSH_CLIENT" | awk '{print $1}'`, {
      spawnSync,
      env,
      mode: "pubkey",
      identities,
      timeoutMs: 30_000,
    });
    if (r.status === 0) {
      const ip = `${r.stdout ?? ""}`.trim();
      if (ip) {
        sshClientIp = ip;
        break;
      }
    }
  }

  const gate = resolveMaintainSourceAllowed({
    sshClientIp,
    localIps: localIpv4Addresses(),
    allowedCidrs: hostFirewallAllowedCidrsFromConfig(cfg),
  });

  if (!gate.allowed) {
    const seen = gate.checkedIps.length ? gate.checkedIps.join(", ") : "(none)";
    warn(
      `guest firewall: skipped — maintain source ${seen} not in allowed host subnets. Re-run from an allowed LAN.`,
    );
    return { ok: true, skipped: true, reason: "source_not_allowed", results: [] };
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  for (const guest of guests) {
    const sshTarget = targetById.get(guest.hostId);
    const fwPath = guestFirewallPathForVmid(String(guest.vmid));
    /** @type {Record<string, unknown>} */
    const row = {
      systemId: guest.systemId,
      vmid: guest.vmid,
      hostId: guest.hostId,
      path: fwPath,
    };

    if (!sshTarget) {
      ok = false;
      warn(`[${guest.systemId}] hypervisor ${guest.hostId} not in config — skip vmid ${guest.vmid}.`);
      row.ok = false;
      row.error = "hypervisor not configured";
      results.push(row);
      continue;
    }

    if (!sshReachableWithPubkey(sshTarget, spawnSync, env, identities)) {
      ok = false;
      warn(`[${guest.systemId}] SSH to ${guest.hostId} failed — skip ${fwPath}.`);
      row.ok = false;
      row.error = "ssh unreachable";
      results.push(row);
      continue;
    }

    log(`[${guest.systemId}] ${fwPath} on ${guest.hostId} …`);
    const readR = sshBashLc(
      sshTarget,
      `if [ -f ${shellSingleQuote(fwPath)} ]; then cat ${shellSingleQuote(fwPath)}; fi`,
      { spawnSync, env, mode: "pubkey", identities, timeoutMs: 60_000 },
    );
    if (readR.status !== 0) {
      ok = false;
      const err = `${readR.stderr ?? ""}${readR.stdout ?? ""}`.trim() || `ssh exit ${readR.status ?? "?"}`;
      warn(`[${guest.systemId}] read failed: ${err}`);
      row.ok = false;
      row.error = err;
      results.push(row);
      continue;
    }

    const existing = `${readR.stdout ?? ""}`;
    const merged = mergeGuestFirewallSection(existing, hdcSection);
    row.changed = merged !== existing;

    if (!row.changed) {
      log(`[${guest.systemId}] ${fwPath} already up to date.`);
      row.ok = true;
      results.push(row);
      continue;
    }

    if (dryRun) {
      log(`[${guest.systemId}] would update ${fwPath}.`);
      row.ok = true;
      results.push(row);
      continue;
    }

    const writeR = sshBashLc(sshTarget, buildWriteFirewallScript(fwPath, merged), {
      spawnSync,
      env,
      mode: "pubkey",
      identities,
      timeoutMs: 120_000,
    });
    if (writeR.status !== 0) {
      ok = false;
      const err = `${writeR.stderr ?? ""}${writeR.stdout ?? ""}`.trim() || `ssh exit ${writeR.status ?? "?"}`;
      warn(`[${guest.systemId}] write failed: ${err}`);
      row.ok = false;
      row.error = err;
      results.push(row);
      continue;
    }

    const msg = `${writeR.stdout ?? ""}`.trim();
    log(`[${guest.systemId}] ${fwPath} ${msg || "updated"}.`);
    row.ok = true;
    results.push(row);
  }

  return { ok, skipped: false, results };
}
