import { existsSync, readFileSync } from "node:fs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
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

const PROBE_BEGIN = "HDC_OEM_BEGIN";
const PROBE_END = "HDC_OEM_END";

/**
 * @typedef {object} OemLicenseAssignment
 * @property {number} vmid
 * @property {string} tableRef
 */

/**
 * @typedef {object} OemLicenseHostResult
 * @property {string} hostId
 * @property {string} pveNode
 * @property {string | null} clusterId
 * @property {{ msdm: boolean; slic: boolean }} firmware
 * @property {string[]} dumpedTables
 * @property {OemLicenseAssignment[]} assigned
 * @property {string} status
 * @property {string} summary
 * @property {string} [error]
 */

/**
 * @param {unknown} cfg
 */
export function oemWindowsLicenseEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return true;
  const oem = provision.oem_windows_license;
  if (!isProxmoxConfigObject(oem)) return true;
  return oem.enabled !== false && oem.enabled !== 0;
}

/**
 * @param {string} pveNode
 * @returns {string}
 */
export function buildOemLicenseProbeScript(pveNode) {
  const nodeQ = shellSingleQuote(pveNode);
  return `
set -e
NODE=${nodeQ}
QDIR="/etc/pve/nodes/$NODE/qemu-server"
echo ${shellSingleQuote(PROBE_BEGIN)}
if [ -r /sys/firmware/acpi/tables/MSDM ]; then echo FIRMWARE_MSDM=1; else echo FIRMWARE_MSDM=0; fi
if [ -r /sys/firmware/acpi/tables/SLIC ]; then echo FIRMWARE_SLIC=1; else echo FIRMWARE_SLIC=0; fi
for f in MSDM_table SLIC_table; do
  if [ -f "$QDIR/$f" ]; then echo "DUMPED_TABLE=$f"; fi
done
if [ -d "$QDIR" ]; then
  for conf in "$QDIR"/*.conf; do
    [ -f "$conf" ] || continue
    vmid=$(basename "$conf" .conf)
    grep -E '^args:.*acpitable' "$conf" 2>/dev/null | while IFS= read -r line; do
      table=$(printf '%s' "$line" | sed -n 's/.*file=\\([^[:space:]]*\\).*/\\1/p' | sed 's|.*/||')
      [ -n "$table" ] || table=unknown
      echo "VM_ASSIGNED vmid=$vmid table=$table"
    done
  done
fi
echo ${shellSingleQuote(PROBE_END)}
`.trim();
}

/**
 * @param {string} pathOrName
 * @returns {string}
 */
export function normalizeOemTableRef(pathOrName) {
  const s = String(pathOrName ?? "").trim();
  if (!s) return "";
  const slash = s.lastIndexOf("/");
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/**
 * @param {string} stdout
 * @param {string} pveNode
 * @returns {{ firmware: { msdm: boolean; slic: boolean }; dumpedTables: string[]; assigned: OemLicenseAssignment[] }}
 */
export function parseOemLicenseProbeOutput(stdout, pveNode) {
  const text = String(stdout ?? "");
  const begin = text.indexOf(PROBE_BEGIN);
  const end = text.indexOf(PROBE_END);
  const block =
    begin >= 0 && end > begin
      ? text.slice(begin + PROBE_BEGIN.length, end)
      : text;

  /** @type {{ msdm: boolean; slic: boolean }} */
  const firmware = { msdm: false, slic: false };
  /** @type {string[]} */
  const dumpedTables = [];
  /** @type {OemLicenseAssignment[]} */
  const assigned = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "FIRMWARE_MSDM=1") firmware.msdm = true;
    else if (line === "FIRMWARE_SLIC=1") firmware.slic = true;
    else if (line.startsWith("DUMPED_TABLE=")) {
      const name = line.slice("DUMPED_TABLE=".length).trim();
      if (name && !dumpedTables.includes(name)) dumpedTables.push(name);
    } else if (line.startsWith("VM_ASSIGNED ")) {
      const vmidMatch = line.match(/vmid=(\d+)/);
      const tableMatch = line.match(/table=(\S+)/);
      const vmid = vmidMatch ? Number.parseInt(vmidMatch[1], 10) : NaN;
      const tableRef = tableMatch ? normalizeOemTableRef(tableMatch[1]) : "";
      if (Number.isFinite(vmid) && tableRef) {
        assigned.push({ vmid, tableRef });
      }
    }
  }

  void pveNode;
  return { firmware, dumpedTables, assigned };
}

/**
 * @param {object} host
 * @param {{ msdm: boolean; slic: boolean }} host.firmware
 * @param {string[]} host.dumpedTables
 * @param {OemLicenseAssignment[]} host.assigned
 * @param {string} [host.error]
 * @returns {{ status: string; summary: string }}
 */
export function summarizeOemLicenseHost(host) {
  if (host.error) {
    return { status: "ssh_error", summary: host.error };
  }

  const hasFirmware = host.firmware.msdm || host.firmware.slic;
  const firmwareLabel = [
    host.firmware.msdm ? "MSDM" : "",
    host.firmware.slic ? "SLIC" : "",
  ]
    .filter(Boolean)
    .join("+");
  const assignCount = host.assigned.length;
  const dumped = host.dumpedTables.length > 0 ? host.dumpedTables.join(", ") : "—";

  if (assignCount > 1) {
    const vmids = host.assigned.map((a) => a.vmid).join(", ");
    return {
      status: "multi_assigned",
      summary: `OEM table passed to ${assignCount} VMs (${vmids}); only one Windows VM per host is supported`,
    };
  }

  if (assignCount === 1 && !hasFirmware) {
    const a = host.assigned[0];
    return {
      status: "assigned_without_firmware",
      summary: `VM ${a.vmid} has -acpitable (${a.tableRef}) but no MSDM/SLIC firmware table on host`,
    };
  }

  if (assignCount === 1) {
    const a = host.assigned[0];
    return {
      status: "assigned",
      summary: `VM ${a.vmid} uses ${a.tableRef}${firmwareLabel ? ` (firmware ${firmwareLabel})` : ""}`,
    };
  }

  if (host.dumpedTables.length > 0) {
    return {
      status: "dumped_unassigned",
      summary: `Dumped ${dumped} on node but no QEMU VM has -acpitable passthrough`,
    };
  }

  if (hasFirmware) {
    return {
      status: "firmware_only",
      summary: `Firmware ${firmwareLabel} present; not assigned to any VM`,
    };
  }

  return { status: "none", summary: "No OEM Windows ACPI table (MSDM/SLIC) on host" };
}

/**
 * @param {OemLicenseHostResult} host
 * @returns {string[]}
 */
export function oemLicenseWarningsForHost(host) {
  /** @type {string[]} */
  const warnings = [];
  const label = host.hostId;

  if (host.status === "firmware_only") {
    warnings.push(
      `${label}: OEM Windows license (${host.firmware.msdm ? "MSDM" : ""}${host.firmware.msdm && host.firmware.slic ? "+" : ""}${host.firmware.slic ? "SLIC" : ""}) available but not passed through to any VM`,
    );
  } else if (host.status === "multi_assigned") {
    const vmids = host.assigned.map((a) => a.vmid).join(", ");
    warnings.push(`${label}: OEM -acpitable set on multiple VMs (${vmids}); use at most one Windows VM per host`);
  } else if (host.status === "dumped_unassigned") {
    warnings.push(
      `${label}: dumped OEM table file(s) (${host.dumpedTables.join(", ")}) with no VM -acpitable reference`,
    );
  } else if (host.status === "assigned_without_firmware") {
    warnings.push(`${label}: VM has -acpitable but host has no MSDM/SLIC firmware table`);
  }

  if (host.dumpedTables.length && host.assigned.length) {
    const referenced = new Set(host.assigned.map((a) => a.tableRef));
    const orphan = host.dumpedTables.filter((t) => !referenced.has(t));
    if (orphan.length) {
      warnings.push(`${label}: orphan dumped table file(s): ${orphan.join(", ")}`);
    }
  }

  return warnings;
}

/**
 * @param {string} firmwareMsdm
 * @param {string} firmwareSlic
 * @returns {string}
 */
export function formatOemFirmwareLabel(firmwareMsdm, firmwareSlic) {
  const parts = [];
  if (firmwareMsdm) parts.push("MSDM");
  if (firmwareSlic) parts.push("SLIC");
  return parts.length ? parts.join("+") : "—";
}

/**
 * @param {unknown} cfg
 * @returns {Map<string, { pveNode: string; clusterId: string | null }>}
 */
function pveNodeByHostId(cfg) {
  /** @type {Map<string, { pveNode: string; clusterId: string | null }>} */
  const map = new Map();
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: "",
    configRel: "",
    onSkip: () => {},
  });
  for (const members of byCluster.values()) {
    for (const m of members) {
      map.set(m.id, { pveNode: m.pveNode, clusterId: m.clusterId });
    }
  }
  return map;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @returns {Promise<{ ok: boolean; hosts: OemLicenseHostResult[] }>}
 */
export async function runProxmoxOemWindowsLicenseReport(opts) {
  const { clumpRoot, log, warn, dryRun, env, spawnSync } = opts;

  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "OEM Windows license");
  if (!loaded) {
    return { ok: true, hosts: [] };
  }
  const cfg = loaded.data;

  if (!oemWindowsLicenseEnabledFromConfig(cfg)) {
    log("OEM Windows license: disabled in provision.oem_windows_license.enabled — skip.");
    return { ok: true, hosts: [] };
  }

  const targets = listProxmoxHypervisorSshTargets(cfg, env);
  if (!targets.length) {
    warn("OEM Windows license: no SSH targets — skip.");
    return { ok: true, hosts: [] };
  }

  const nodeByHost = pveNodeByHostId(cfg);
  const { identities } = discoverLocalSshMaterial();

  log(`OEM Windows license (SLIC/MSDM): ${targets.length} hypervisor(s)${dryRun ? " [dry-run]" : ""}.`);

  /** @type {OemLicenseHostResult[]} */
  const hosts = [];
  let ok = true;

  for (const target of targets) {
    const meta = nodeByHost.get(target.id);
    const pveNode = meta?.pveNode ?? target.id;
    const clusterId = meta?.clusterId ?? target.clusterId ?? null;

    /** @type {OemLicenseHostResult} */
    const hostResult = {
      hostId: target.id,
      pveNode,
      clusterId,
      firmware: { msdm: false, slic: false },
      dumpedTables: [],
      assigned: [],
      status: "none",
      summary: "",
    };

    if (dryRun) {
      log(`[${target.id}] dry-run: would probe MSDM/SLIC firmware and QEMU -acpitable on node ${pveNode}.`);
      const { status, summary } = summarizeOemLicenseHost(hostResult);
      hostResult.status = status;
      hostResult.summary = summary;
      hosts.push(hostResult);
      continue;
    }

    if (!sshReachableWithPubkey(target, spawnSync, env, identities)) {
      ok = false;
      hostResult.error = "SSH unreachable (public-key auth failed)";
      const { status, summary } = summarizeOemLicenseHost(hostResult);
      hostResult.status = status;
      hostResult.summary = summary;
      warn(`[${target.id}] ${hostResult.summary}`);
      hosts.push(hostResult);
      continue;
    }

    log(`[${target.id}] probing OEM Windows license tables (node ${pveNode}) …`);
    const script = buildOemLicenseProbeScript(pveNode);
    const r = sshBashLc(target, script, {
      spawnSync,
      env,
      mode: "pubkey",
      identities,
      timeoutMs: 60_000,
    });

    if (r.status !== 0) {
      ok = false;
      const err = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim() || `ssh exit ${r.status ?? "?"}`;
      hostResult.error = err.slice(0, 500);
      const { status, summary } = summarizeOemLicenseHost(hostResult);
      hostResult.status = status;
      hostResult.summary = summary;
      warn(`[${target.id}] OEM license probe failed: ${hostResult.summary}`);
      hosts.push(hostResult);
      continue;
    }

    const parsed = parseOemLicenseProbeOutput(`${r.stdout ?? ""}`, pveNode);
    hostResult.firmware = parsed.firmware;
    hostResult.dumpedTables = parsed.dumpedTables;
    hostResult.assigned = parsed.assigned;
    const { status, summary } = summarizeOemLicenseHost(hostResult);
    hostResult.status = status;
    hostResult.summary = summary;
    log(`[${target.id}] ${summary}`);

    for (const w of oemLicenseWarningsForHost(hostResult)) {
      warn(w);
    }

    hosts.push(hostResult);
  }

  return { ok, hosts };
}
