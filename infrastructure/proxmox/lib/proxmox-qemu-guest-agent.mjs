import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "./proxmox-deploy-auth.mjs";
import { fetchClusterVmResources } from "./proxmox-host-provisioner.mjs";

/** @typedef {import("./proxmox-host-load-report.mjs").GuestConfig} GuestConfig */
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { loadProxmoxHostsByCluster, isProxmoxConfigObject } from "./proxmox-config.mjs";
import { guestConfigFromResource } from "./proxmox-host-load-report.mjs";
import { pveData, pveJsonRequest } from "./pve-http.mjs";

/**
 * @typedef {"disabled" | "enabled_stopped" | "ok" | "not_responding" | "permission_denied"} QemuGuestAgentStatus
 */

/**
 * @typedef {object} QemuGuestAgentProbe
 * @property {boolean} attempted
 * @property {boolean} ok
 * @property {number} [httpStatus]
 * @property {string} [error]
 */

/**
 * @typedef {object} QemuGuestAgentRow
 * @property {number} vmid
 * @property {string} name
 * @property {string} node
 * @property {string} status
 * @property {QemuGuestAgentStatus} agentStatus
 * @property {boolean} configEnabled
 * @property {string} summary
 * @property {string} [notes]
 */

/**
 * @typedef {object} QemuGuestAgentHostReport
 * @property {string} hostId
 * @property {string} pveNode
 * @property {QemuGuestAgentRow[]} guests
 */

/**
 * @typedef {object} QemuGuestAgentClusterReport
 * @property {string} id
 * @property {QemuGuestAgentHostReport[]} hosts
 */

/**
 * @typedef {object} QemuGuestAgentReportData
 * @property {boolean} ok
 * @property {string[]} warnings
 * @property {QemuGuestAgentClusterReport[]} clusters
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function qemuAgentEnabledFromConfig(value) {
  if (value === 1 || value === true) return true;
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  if (!s) return false;
  if (s === "1") return true;
  if (s === "enabled=1" || s === "enabled=on") return true;
  if (/^enabled\s*=\s*1$/i.test(s)) return true;
  return false;
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown> | null}
 */
function configRecordFromBody(body) {
  const d = pveData(body);
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  return /** @type {Record<string, unknown>} */ (d);
}

/**
 * @param {string} message
 * @returns {number | null}
 */
export function httpStatusFromPveError(message) {
  const m = String(message ?? "").match(/Proxmox HTTP (\d{3})/);
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} message
 * @returns {boolean}
 */
export function isGuestAgentPermissionError(message) {
  const code = httpStatusFromPveError(message);
  if (code === 403 || code === 401) return true;
  const lower = String(message ?? "").toLowerCase();
  return lower.includes("permission") && lower.includes("guest");
}

/**
 * @param {object} opts
 * @param {GuestConfig} opts.guest
 * @param {boolean} opts.configEnabled
 * @param {QemuGuestAgentProbe | null} opts.probe
 * @returns {{ agentStatus: QemuGuestAgentStatus; summary: string; notes?: string }}
 */
export function classifyQemuGuestAgentRow(opts) {
  const { guest, configEnabled, probe } = opts;
  const running = guest.status === "running";

  if (!configEnabled) {
    return {
      agentStatus: "disabled",
      summary: running ? "agent not enabled in VM config" : "agent disabled (VM stopped)",
    };
  }

  if (!running) {
    return {
      agentStatus: "enabled_stopped",
      summary: "agent enabled in config; VM not running (ping skipped)",
    };
  }

  if (!probe || !probe.attempted) {
    return {
      agentStatus: "not_responding",
      summary: "agent enabled; ping not attempted",
    };
  }

  if (probe.ok) {
    return { agentStatus: "ok", summary: "agent enabled and responding" };
  }

  if (isGuestAgentPermissionError(probe.error ?? "")) {
    return {
      agentStatus: "permission_denied",
      summary: "agent enabled; API permission denied for guest-agent ping",
      notes: probe.error,
    };
  }

  return {
    agentStatus: "not_responding",
    summary: "agent enabled in config but guest agent not responding",
    notes: probe.error,
  };
}

/**
 * @param {QemuGuestAgentRow} row
 * @returns {string[]}
 */
export function guestAgentWarningsForRow(row) {
  /** @type {string[]} */
  const warnings = [];
  const label = `vmid ${row.vmid} ${row.name} on ${row.node}`;

  if (row.agentStatus === "not_responding" && row.status === "running") {
    warnings.push(`${label}: QEMU guest agent enabled but not responding`);
  } else if (row.agentStatus === "permission_denied") {
    warnings.push(
      `${label}: guest agent ping denied — ensure hdc API role includes VM.GuestAgent.Audit (PVE 9) or VM.Monitor (PVE 8)`,
    );
  }

  return warnings;
}

/**
 * @param {QemuGuestAgentReportData} data
 * @returns {string[]}
 */
export function guestAgentWarningsFromReport(data) {
  /** @type {string[]} */
  const warnings = [];
  for (const cluster of data.clusters) {
    for (const host of cluster.hosts) {
      for (const row of host.guests) {
        warnings.push(...guestAgentWarningsForRow(row));
      }
    }
  }
  return warnings;
}

/**
 * @param {string} apiBase
 * @param {string} node
 * @param {number} vmid
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<{ enabled: boolean; config: Record<string, unknown> | null }>}
 */
export async function fetchQemuConfigAgentState(
  apiBase,
  node,
  vmid,
  authorization,
  rejectUnauthorized,
) {
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    undefined,
  );
  const config = configRecordFromBody(body);
  const enabled = config ? qemuAgentEnabledFromConfig(config.agent) : false;
  return { enabled, config };
}

/**
 * @param {string} apiBase
 * @param {string} node
 * @param {number} vmid
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<QemuGuestAgentProbe>}
 */
export async function pingQemuGuestAgent(apiBase, node, vmid, authorization, rejectUnauthorized) {
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/agent/ping`;
  try {
    await pveJsonRequest("POST", apiBase, path, authorization, rejectUnauthorized, undefined);
    return { attempted: true, ok: true };
  } catch (e) {
    const err = /** @type {Error} */ (e);
    return {
      attempted: true,
      ok: false,
      httpStatus: httpStatusFromPveError(err.message) ?? undefined,
      error: err.message || String(e),
    };
  }
}

/**
 * @param {QemuGuestAgentRow[]} guests
 * @returns {string}
 */
export function summarizeGuestAgentCounts(guests) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const g of guests) {
    counts[g.agentStatus] = (counts[g.agentStatus] ?? 0) + 1;
  }
  const order = ["ok", "not_responding", "permission_denied", "enabled_stopped", "disabled"];
  const parts = order.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`);
  return parts.length ? parts.join(", ") : "no QEMU workload VMs";
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} [opts.warn]
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 * @returns {Promise<QemuGuestAgentReportData>}
 */
export async function collectProxmoxQemuGuestAgentReport(opts) {
  const { clumpRoot, warn = () => {}, vault } = opts;
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "QEMU guest agent");
  if (!loaded) {
    return { ok: true, warnings: [], clusters: [] };
  }
  const cfg = loaded.data;

  /** @type {string[]} */
  const warnings = [];
  const warnPush = (line) => {
    warnings.push(line);
    warn(line);
  };

  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: loaded.path,
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: (id, reason) => warnPush(`Guest agent: skip host ${JSON.stringify(id)} (${reason})`),
  });

  /** @type {QemuGuestAgentClusterReport[]} */
  const clusters = [];
  let ok = true;

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
      warnPush(`Guest agent: skipping cluster ${JSON.stringify(clusterKey)} — no API auth.`);
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
        `Guest agent: cluster ${JSON.stringify(clusterKey)} VM list failed: ${/** @type {Error} */ (e).message || e}`,
      );
      continue;
    }

    /** @type {QemuGuestAgentHostReport[]} */
    const hosts = [];

    for (const m of members) {
      /** @type {QemuGuestAgentRow[]} */
      const guestRows = [];

      for (const row of resourceRows) {
        if (!isProxmoxConfigObject(row)) continue;
        const typ = typeof row.type === "string" ? row.type.trim() : "";
        if (typ !== "qemu") continue;
        if (row.template === 1 || row.template === true) continue;
        const node = typeof row.node === "string" ? row.node.trim() : "";
        if (node !== m.pveNode) continue;

        const guest = guestConfigFromResource(row);
        if (!guest) continue;
        const status = typeof row.status === "string" ? row.status.trim() : "unknown";

        let configEnabled = false;
        try {
          const st = await fetchQemuConfigAgentState(
            auth.host.apiBase,
            node,
            guest.vmid,
            auth.authorization,
            auth.rejectUnauthorized,
          );
          configEnabled = st.enabled;
        } catch (e) {
          warnPush(
            `Guest agent: vmid ${guest.vmid} config read failed: ${/** @type {Error} */ (e).message || e}`,
          );
        }

        /** @type {QemuGuestAgentProbe | null} */
        let probe = null;
        if (status === "running" && configEnabled) {
          probe = await pingQemuGuestAgent(
            auth.host.apiBase,
            node,
            guest.vmid,
            auth.authorization,
            auth.rejectUnauthorized,
          );
        }

        const classified = classifyQemuGuestAgentRow({
          guest: { ...guest, status },
          configEnabled,
          probe,
        });

        guestRows.push({
          vmid: guest.vmid,
          name: guest.name,
          node,
          status,
          configEnabled,
          agentStatus: classified.agentStatus,
          summary: classified.summary,
          notes: classified.notes,
        });
      }

      guestRows.sort((a, b) => a.vmid - b.vmid);
      hosts.push({ hostId: m.id, pveNode: m.pveNode, guests: guestRows });
    }

    clusters.push({ id: clusterKey, hosts });
  }

  const data = { ok, warnings, clusters };
  for (const w of guestAgentWarningsFromReport(data)) {
    warnPush(w);
  }
  if (warnings.length) ok = false;

  return data;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} [opts.warn]
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 * @returns {Promise<{ ok: boolean; data: QemuGuestAgentReportData }>}
 */
export async function runProxmoxQemuGuestAgentReport(opts) {
  const { clumpRoot, log, warn = () => {} } = opts;

  log("QEMU guest agent report (config + ping for running VMs) …");

  const data = await collectProxmoxQemuGuestAgentReport({
    clumpRoot,
    warn,
    vault: opts.vault,
  });

  for (const cluster of data.clusters) {
    for (const host of cluster.hosts) {
      log(
        `Host ${JSON.stringify(host.hostId)} (${JSON.stringify(cluster.id)}) — ${summarizeGuestAgentCounts(host.guests)}`,
      );
      for (const row of host.guests) {
        const cfgLabel = row.configEnabled ? "enabled" : "disabled";
        log(
          `  vmid ${row.vmid} ${row.name} [${row.status}]: config ${cfgLabel}, agent ${row.agentStatus}`,
        );
      }
    }
  }

  if (data.ok) log("QEMU guest agent report finished.");
  else log("QEMU guest agent report finished with issues — see warnings.");

  return { ok: data.ok, data };
}
