import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { preferredClumpReportPath } from "hdc/cli/lib/private-repo.mjs";
import { maybeNotifyOpsDiscordFromProxmoxMaintain } from "hdc/cli/lib/ops-discord-notify.mjs";
import {
  CRIT_PCT,
  WARN_PCT,
  formatBytes,
  formatGuestLine,
  formatHostLoadSummary,
} from "./proxmox-host-load-report.mjs";
import { renderGuestRootdiskMarkdown } from "./proxmox-guest-rootdisk-maintain.mjs";

/**
 * @typedef {object} MaintainStepRecord
 * @property {string} id
 * @property {string} title
 * @property {boolean} ran
 * @property {string} [skipReason]
 * @property {boolean | null} ok
 * @property {string[]} notes
 */

/**
 * @typedef {object} MaintainReportContext
 * @property {string} collectedAt
 * @property {boolean} dryRun
 * @property {Record<string, boolean | string>} flags
 * @property {MaintainStepRecord[]} steps
 * @property {string[]} warnings
 * @property {import("./proxmox-host-load-report.mjs").CapacityReportData | null} capacity
 * @property {Record<string, unknown>[]} templateChecks
 * @property {string[]} downHosts
 * @property {import("./proxmox-oem-windows-license.mjs").OemLicenseHostResult[]} [oemWindowsLicense]
 * @property {import("./proxmox-qemu-guest-agent.mjs").QemuGuestAgentReportData | null} [qemuGuestAgent]
 * @property {import("./proxmox-guest-rootdisk-maintain.mjs").GuestRootdiskReportData | null} [guestRootdisk]
 * @property {Record<string, unknown>[]} [mailRelay]
 * @property {number | null} exitCode
 * @property {string | null} reportPath
 */

/**
 * @param {string[]} argv
 * @returns {MaintainReportContext}
 */
export function createMaintainReportContext(argv) {
  const dryRun = argv.includes("--dry-run");
  /** @type {Record<string, boolean | string>} */
  const flags = {
    dryRun,
    skipSshKeys: argv.includes("--skip-ssh-keys"),
    skipApiToken: argv.includes("--skip-api-token"),
    skipTemplates: argv.includes("--skip-templates"),
    skipStorage: argv.includes("--skip-storage"),
    skipBackups: argv.includes("--skip-backups"),
    skipNotifications: argv.includes("--skip-notifications"),
    skipReplication: argv.includes("--skip-replication"),
    skipHa: argv.includes("--skip-ha"),
    skipStartup: argv.includes("--skip-startup"),
    skipGuestTags: argv.includes("--skip-guest-tags"),
    skipLocalLvm: argv.includes("--skip-local-lvm"),
    skipOsUpdates: argv.includes("--skip-os-updates"),
    skipLoadReport: argv.includes("--skip-load-report"),
    skipOemLicense: argv.includes("--skip-oem-license"),
    skipGuestAgent: argv.includes("--skip-guest-agent"),
    expandGuestRootfs: argv.includes("--expand-guest-rootfs"),
    skipMailRelay: argv.includes("--skip-mail-relay"),
    noDownload: argv.includes("--no-download"),
    noBuildQemu: argv.includes("--no-build-qemu"),
    noPrune: argv.includes("--no-prune"),
    noReport: argv.includes("--no-report"),
    noDiscordNotify: argv.includes("--no-discord-notify"),
  };
  const reportIdx = argv.indexOf("--report");
  if (reportIdx >= 0 && argv[reportIdx + 1]) {
    flags.reportPath = argv[reportIdx + 1];
  }

  return {
    collectedAt: new Date().toISOString(),
    dryRun,
    flags,
    steps: [],
    warnings: [],
    capacity: null,
    templateChecks: [],
    downHosts: [],
    oemWindowsLicense: [],
    qemuGuestAgent: null,
    guestRootdisk: null,
    mailRelay: [],
    exitCode: null,
    reportPath: null,
  };
}

/** Configured vCPU % thresholds (allocated vCPU vs physical cores). */
export const CONFIGURED_CPU_WARN_PCT = 100;
export const CONFIGURED_CPU_CRIT_PCT = 200;

/**
 * @param {number | null} pct
 * @returns {boolean}
 */
export function isConfiguredCpuWarnPct(pct) {
  return pct !== null && pct >= CONFIGURED_CPU_WARN_PCT;
}

/**
 * @param {number | null} pct
 * @returns {boolean}
 */
export function isConfiguredCpuCritPct(pct) {
  return pct !== null && pct >= CONFIGURED_CPU_CRIT_PCT;
}

/**
 * @param {Record<string, boolean | string>} flags
 * @returns {{ set: string[]; notSet: string[] }}
 */
export function splitMaintainSummaryFlags(flags) {
  /** @type {[string, string, boolean | string | undefined][]} */
  const entries = [
    ["--dry-run", "dryRun", flags.dryRun],
    ["--skip-ssh-keys", "skipSshKeys", flags.skipSshKeys],
    ["--skip-api-token", "skipApiToken", flags.skipApiToken],
    ["--skip-templates", "skipTemplates", flags.skipTemplates],
    ["--skip-storage", "skipStorage", flags.skipStorage],
    ["--skip-local-lvm", "skipLocalLvm", flags.skipLocalLvm],
    ["--skip-os-updates", "skipOsUpdates", flags.skipOsUpdates],
    ["--skip-oem-license", "skipOemLicense", flags.skipOemLicense],
    ["--skip-load-report", "skipLoadReport", flags.skipLoadReport],
    ["--skip-guest-agent", "skipGuestAgent", flags.skipGuestAgent],
    ["--no-download", "noDownload", flags.noDownload],
    ["--no-build-qemu", "noBuildQemu", flags.noBuildQemu],
    ["--no-prune", "noPrune", flags.noPrune],
    ["--no-report", "noReport", flags.noReport],
  ];
  /** @type {string[]} */
  const set = [];
  /** @type {string[]} */
  const notSet = [];
  for (const [flag, , val] of entries) {
    if (val) set.push(flag);
    else notSet.push(flag);
  }
  const reportPath = flags.reportPath;
  if (typeof reportPath === "string" && reportPath.trim()) {
    set.push(`--report (${reportPath})`);
  } else {
    notSet.push("--report");
  }
  return { set, notSet };
}

/**
 * @param {import("./proxmox-oem-windows-license.mjs").OemLicenseHostResult[]} hosts
 * @returns {string[]}
 */
export function renderOemWindowsLicenseMarkdown(hosts) {
  /** @type {string[]} */
  const lines = ["## OEM Windows license (SLIC/MSDM)", ""];
  if (!hosts?.length) {
    lines.push("_No hypervisors probed._", "");
    return lines;
  }
  lines.push("| Host | Node | Firmware | Status | Summary |", "| --- | --- | --- | --- | --- |");
  for (const h of hosts) {
    const fw = [
      h.firmware.msdm ? "MSDM" : "",
      h.firmware.slic ? "SLIC" : "",
    ]
      .filter(Boolean)
      .join("+") || "—";
    lines.push(
      `| ${h.hostId} | ${h.pveNode} | ${fw} | ${h.status} | ${h.summary.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
  return lines;
}

/**
 * @param {import("./proxmox-qemu-guest-agent.mjs").QemuGuestAgentReportData} report
 * @returns {string[]}
 */
export function renderQemuGuestAgentMarkdown(report) {
  /** @type {string[]} */
  const lines = [
    "## QEMU guest agent",
    "",
    "LXC containers are omitted; only QEMU workload VMs are listed.",
    "",
  ];
  if (!report?.clusters?.length) {
    lines.push("_No clusters reported._", "");
    return lines;
  }

  let okCount = 0;
  let notOk = 0;
  for (const cluster of report.clusters) {
    lines.push(`### Cluster ${cluster.id}`, "");
    for (const host of cluster.hosts) {
      lines.push(`#### Host ${host.hostId} (\`${host.pveNode}\`)`, "");
      if (!host.guests.length) {
        lines.push("_No QEMU workload VMs._", "");
        continue;
      }
      lines.push("| vmid | name | status | agent | config |", "| ---: | --- | --- | --- | --- |");
      for (const g of host.guests) {
        if (g.agentStatus === "ok") okCount += 1;
        else if (g.status === "running") notOk += 1;
        lines.push(
          `| ${g.vmid} | ${g.name} | ${g.status} | ${g.agentStatus} | ${g.configEnabled ? "enabled" : "disabled"} |`,
        );
      }
      lines.push("");
    }
  }
  lines.push(`**Summary:** ${okCount} ok${notOk ? `, ${notOk} not_responding` : ""}`, "");
  return lines;
}

/**
 * @param {Record<string, unknown>[]} checks
 * @param {object | null} policy
 * @param {boolean} dryRun
 * @returns {string[]}
 */
export function renderTemplateChecksMarkdown(checks, policy, dryRun) {
  /** @type {string[]} */
  const lines = ["## Template checks", ""];
  if (dryRun) lines.push("_Dry run — template mutations were skipped._", "");
  if (policy && typeof policy === "object" && Array.isArray(policy.entries)) {
    lines.push("### Expected templates (policy)", "");
    lines.push("| Release | Expected |", "| --- | --- |");
    for (const entry of policy.entries) {
      const rel = typeof entry.release === "string" ? entry.release : "—";
      const appliance =
        typeof entry.lxcAppliance === "string"
          ? entry.lxcAppliance
          : typeof entry.cloudImageFilename === "string"
            ? entry.cloudImageFilename
            : "—";
      lines.push(`| ${rel} | \`${appliance}\` |`);
    }
    lines.push("");
  }
  lines.push("| Release | Expected | Node | Result |", "| --- | --- | --- | --- |");
  for (const c of checks) {
    const rel = typeof c.release === "string" ? c.release : "—";
    const kind = typeof c.kind === "string" ? c.kind : "";
    const node = typeof c.node === "string" ? c.node : "—";
    const ok = c.ok === true ? "OK" : c.ok === false ? "FAIL" : "—";
    if (kind === "qemu") {
      const vmid =
        typeof c.template_vmid === "number" ? String(c.template_vmid) : "—";
      const name =
        typeof c.template_name === "string" ? `\`${c.template_name}\`` : "—";
      lines.push(`| ${rel} | ${vmid} | ${name} | ${node} | ${ok} |`);
    } else {
      const volid =
        typeof c.expected_volid === "string" ? `\`${c.expected_volid}\`` : "—";
      lines.push(`| ${rel} | ${volid} | ${node} | ${ok} |`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * @param {Record<string, unknown>} host
 */
function hostGuestSections(host) {
  if (Array.isArray(host.guestsRunning) || Array.isArray(host.guestsNotRunning)) {
    return {
      running: /** @type {Record<string, unknown>[]} */ (host.guestsRunning ?? []),
      notRunning: /** @type {Record<string, unknown>[]} */ (host.guestsNotRunning ?? []),
      excluded: /** @type {Record<string, unknown>[]} */ (host.guestsExcluded ?? []),
      totalsRunning: host.totalsRunning ?? host.totals,
    };
  }
  const all = Array.isArray(host.guests) ? host.guests : [];
  /** @type {Record<string, unknown>[]} */
  const running = [];
  /** @type {Record<string, unknown>[]} */
  const notRunning = [];
  for (const g of all) {
    const status = typeof g.status === "string" ? g.status : "";
    if (status === "running") running.push(g);
    else notRunning.push(g);
  }
  return {
    running,
    notRunning,
    excluded: /** @type {Record<string, unknown>[]} */ (host.guestsExcluded ?? []),
    totalsRunning: host.totalsRunning ?? host.totals,
  };
}

/**
 * @param {MaintainReportContext} ctx
 * @param {object} step
 * @param {string} step.id
 * @param {string} step.title
 * @param {boolean} step.ran
 * @param {string} [step.skipReason]
 * @param {boolean | null} [step.ok]
 * @param {string[]} [step.notes]
 */
export function recordStep(ctx, step) {
  ctx.steps.push({
    id: step.id,
    title: step.title,
    ran: step.ran,
    skipReason: step.skipReason,
    ok: step.ok ?? null,
    notes: step.notes ?? [],
  });
}

/**
 * @param {MaintainReportContext} ctx
 * @param {string} line
 */
export function pushWarning(ctx, line) {
  if (!ctx.warnings.includes(line)) ctx.warnings.push(line);
}

/**
 * @param {number | null} pct
 * @returns {boolean}
 */
function isWarnPct(pct) {
  return pct !== null && pct >= WARN_PCT;
}

/**
 * @param {number | null} pct
 * @returns {boolean}
 */
function isCritPct(pct) {
  return pct !== null && pct >= CRIT_PCT;
}

/**
 * @param {string} label
 * @param {number | null} pct
 * @param {string} detail
 * @returns {string | null}
 */
function alertLine(label, pct, detail) {
  if (!isWarnPct(pct)) return null;
  const level = isCritPct(pct) ? "CRITICAL" : "WARNING";
  return `- **${level}** ${label}: ${pct}% used — ${detail}`;
}

/**
 * @param {MaintainReportContext} ctx
 * @returns {string}
 */
export function renderMaintainReportMarkdown(ctx) {
  const lines = [];
  const exitLabel =
    ctx.exitCode === null ? "in progress" : ctx.exitCode === 0 ? "OK" : `failed (exit ${ctx.exitCode})`;

  lines.push("# Proxmox maintain report", "");
  lines.push(`- **Collected:** ${ctx.collectedAt}`);
  lines.push(`- **Outcome:** ${exitLabel}`);
  lines.push(`- **Dry run:** ${ctx.dryRun ? "yes" : "no"}`);
  if (ctx.reportPath) lines.push(`- **Report file:** ${ctx.reportPath}`);
  lines.push("");

  lines.push(
    "Guest `maxdisk` sums can exceed shared pool totals; storage pool percentages below reflect **actual** Proxmox `used/total`, not guest allocation limits alone.",
    "",
  );

  const { set, notSet } = splitMaintainSummaryFlags(ctx.flags);
  lines.push("## Summary flags", "");
  lines.push(`- **Set:** ${set.length ? set.join(", ") : "—"}`);
  lines.push(`- **Not set:** ${notSet.join(", ")}`);
  lines.push("");

  lines.push("## Steps executed", "");
  lines.push("| Step | Status | Result | Notes |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of ctx.steps) {
    const status = s.ran ? "ran" : `skipped${s.skipReason ? ` (${s.skipReason})` : ""}`;
    const result =
      !s.ran ? "—" : s.ok === null ? "—" : s.ok ? "ok" : "**fail**";
    const notes = s.notes.length ? s.notes.join("; ") : "—";
    lines.push(`| ${s.title} | ${status} | ${result} | ${notes} |`);
  }
  lines.push("");

  if (ctx.mailRelay?.length) {
    lines.push("## Mail relay (Postfix satellite)", "");
    for (const h of ctx.mailRelay) {
      const id = typeof h.id === "string" ? h.id : "?";
      const mr = h.mail_relay;
      const status =
        h.dry_run === true
          ? "dry-run"
          : h.ok === true
            ? "ok"
            : "fail";
      const detail =
        mr && typeof mr === "object" && mr !== null && typeof mr.message === "string"
          ? mr.message
          : typeof h.message === "string"
            ? h.message
            : "—";
      lines.push(`- **${id}:** ${status} — ${detail}`);
    }
    lines.push("");
  }

  if (ctx.downHosts.length) {
    lines.push("## Hosts marked down in config", "");
    for (const id of ctx.downHosts) {
      lines.push(`- \`${id}\` — excluded from API/SSH iteration`);
    }
    lines.push("");
  }

  if (ctx.warnings.length) {
    lines.push("## Warnings", "");
    for (const w of ctx.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  const cap = ctx.capacity;
  if (cap?.clusters.length) {
    lines.push("## Configured guest allocation", "");
    for (const cluster of cap.clusters) {
      lines.push(`### Cluster ${cluster.id}`, "");
      for (const host of cluster.hosts) {
        lines.push(`#### Host ${host.id} (\`${host.pveNode}\`)`, "");
        const { running, notRunning, excluded, totalsRunning } = hostGuestSections(host);
        const counts = host.counts;
        if (counts && typeof counts === "object") {
          lines.push(
            `**Running:** ${counts.running ?? running.length} · **Not running:** ${counts.notRunning ?? notRunning.length} · **Excluded templates:** ${counts.excluded ?? excluded.length}`,
            "",
          );
        }
        const renderGuestTable = (title, guests) => {
          lines.push(`##### ${title}`, "");
          if (!guests.length) {
            lines.push("_None._", "");
            return;
          }
          lines.push("| vmid | name | type | vCPU | RAM | disk |");
          lines.push("| ---: | --- | --- | ---: | --- | --- |");
          for (const g of guests) {
            lines.push(
              `| ${g.vmid} | ${g.name} | ${g.type} | ${g.maxcpu} | ${formatBytes(g.maxmem)} | ${formatBytes(g.maxdisk)} |`,
            );
          }
          lines.push("");
        };
        renderGuestTable("Running", running);
        renderGuestTable("Not running", notRunning);
        if (excluded.length) {
          lines.push("##### Excluded templates", "");
          for (const g of excluded) {
            lines.push(`- vmid ${g.vmid} ${g.name} (${g.type})`);
          }
          lines.push("");
        }
        const tr = totalsRunning ?? host.totals;
        const cpuPct = host.loadPercent.cpu;
        const memPct = host.loadPercent.mem;
        const diskPct = host.loadPercent.disk;
        const cpuStr =
          cpuPct === null
            ? `${tr.maxcpu} vCPU allocated (host CPUs unknown)`
            : `${tr.maxcpu}/${host.capacity.cpuCount} vCPU (${cpuPct}%)`;
        const memStr =
          memPct === null
            ? `${formatBytes(tr.maxmem)} allocated`
            : `${formatBytes(tr.maxmem)} / ${formatBytes(host.capacity.memoryBytes)} (${memPct}%)`;
        const diskStr =
          diskPct === null
            ? `${formatBytes(tr.maxdisk)} guest maxdisk sum`
            : `${formatBytes(tr.maxdisk)} / ${formatBytes(host.storageCapacityBytes)} configured (${diskPct}%)`;
        lines.push(
          `**Configured load (running guests only):** CPU ${cpuStr}; RAM ${memStr}; disk ${diskStr}`,
          "",
        );
      }
    }
  } else if (!ctx.flags.skipLoadReport && !ctx.flags.noReport) {
    lines.push("## Configured guest allocation", "");
    lines.push("_No capacity data collected (API auth or config missing)._", "");
  }

  if (cap?.clusters.length) {
    lines.push("## Storage and disk usage", "");
    for (const cluster of cap.clusters) {
      lines.push(`### Cluster ${cluster.id}`, "");
      for (const host of cluster.hosts) {
        lines.push(`#### Host ${host.id} (\`${host.pveNode}\`)`, "");
        if (host.rootfs) {
          const r = host.rootfs;
          lines.push(
            `**Root filesystem:** ${formatBytes(r.used)} / ${formatBytes(r.total)} used (${r.usedPercent ?? "?"}%) — ${r.headroom}`,
            "",
          );
        } else {
          lines.push("**Root filesystem:** _status unavailable_", "");
        }
        if (host.storagePools.length) {
          lines.push("| Pool | type | total | used | avail | % used | headroom |");
          lines.push("| --- | --- | --- | --- | --- | ---: | --- |");
          for (const p of host.storagePools) {
            lines.push(
              `| ${p.id} | ${p.type || "—"} | ${formatBytes(p.total)} | ${formatBytes(p.used)} | ${formatBytes(p.avail)} | ${p.usedPercent ?? "—"} | ${p.headroom} |`,
            );
          }
          lines.push("");
        } else {
          lines.push("_No storage pools on this node._", "");
        }
      }
    }
  }

  /** @type {string[]} */
  const alerts = [];
  if (cap) {
    for (const cluster of cap.clusters) {
      for (const host of cluster.hosts) {
        if (host.rootfs) {
          const a = alertLine(
            `Root filesystem on ${host.id}`,
            host.rootfs.usedPercent,
            `${formatBytes(host.rootfs.used)} / ${formatBytes(host.rootfs.total)}`,
          );
          if (a) alerts.push(a);
        }
        for (const p of host.storagePools) {
          const a = alertLine(
            `Storage ${p.id} on ${host.id}`,
            p.usedPercent,
            `${formatBytes(p.used)} / ${formatBytes(p.total)}`,
          );
          if (a) alerts.push(a);
        }
        if (isConfiguredCpuCritPct(host.loadPercent.cpu)) {
          alerts.push(
            `- **CRITICAL** Configured vCPU on ${host.id}: ${host.loadPercent.cpu}% of host CPUs`,
          );
        } else if (isConfiguredCpuWarnPct(host.loadPercent.cpu)) {
          alerts.push(
            `- **WARNING** Configured vCPU on ${host.id}: ${host.loadPercent.cpu}% of host CPUs`,
          );
        }
        if (isWarnPct(host.loadPercent.mem)) {
          alerts.push(
            `- **${isCritPct(host.loadPercent.mem) ? "CRITICAL" : "WARNING"}** Configured RAM on ${host.id}: ${host.loadPercent.mem}% of host RAM`,
          );
        }
      }
    }
  }

  lines.push("## Alerts", "");
  if (alerts.length) {
    lines.push(...alerts, "");
  } else {
    lines.push("_No pools or root filesystems at or above 85% used._", "");
  }

  if (ctx.oemWindowsLicense?.length) {
    lines.push(...renderOemWindowsLicenseMarkdown(ctx.oemWindowsLicense));
  }

  if (ctx.qemuGuestAgent) {
    lines.push(...renderQemuGuestAgentMarkdown(ctx.qemuGuestAgent));
  }

  if (ctx.guestRootdisk?.guests?.length) {
    lines.push(...renderGuestRootdiskMarkdown(ctx.guestRootdisk.guests));
  }

  if (ctx.templateChecks.length) {
    lines.push(
      ...renderTemplateChecksMarkdown(ctx.templateChecks, ctx.templatePolicy ?? null, ctx.dryRun),
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {string} clumpRoot
 * @param {string} [reportPathArg]
 * @param {string} [publicRoot] hdc repo root; when set, prefer hdc-private for default path
 * @returns {string}
 */
export function defaultMaintainReportPath(clumpRoot, reportPathArg, publicRoot) {
  if (reportPathArg?.trim()) {
    const p = reportPathArg.trim();
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const basename = `maintain-${ts}.md`;
  if (publicRoot?.trim()) {
    return preferredClumpReportPath(publicRoot.trim(), clumpRoot, basename);
  }
  return join(clumpRoot, "reports", basename);
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {MaintainReportContext} opts.ctx
 * @param {string} [opts.reportPathArg]
 * @param {string} [opts.publicRoot] hdc repo root
 * @returns {string | null} written path, or null if skipped
 */
export function writeMaintainReportFile(opts) {
  const { clumpRoot, ctx, reportPathArg, publicRoot } = opts;
  if (ctx.flags.noReport) return null;

  const outPath = defaultMaintainReportPath(clumpRoot, reportPathArg, publicRoot);
  ctx.reportPath = outPath;
  const markdown = renderMaintainReportMarkdown(ctx);
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, markdown, "utf8");
  maybeNotifyOpsDiscordFromProxmoxMaintain(ctx);
  return outPath;
}

/**
 * Append stderr-style guest lines for debugging (optional export for tests).
 * @param {import("./proxmox-host-load-report.mjs").HostCapacityReport} host
 * @returns {string[]}
 */
export function hostCapacityLogLines(host) {
  const lines = [];
  for (const g of host.guests) {
    lines.push(formatGuestLine(g));
  }
  lines.push(
    formatHostLoadSummary({
      totals: host.totals,
      capacity: host.capacity,
      storageCapacityBytes: host.storageCapacityBytes,
    }),
  );
  return lines;
}
