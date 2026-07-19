#!/usr/bin/env node
/**
 * Proxmox maintain:
 * 1. Install local SSH public keys on each hypervisor (password from vault if needed).
 * 2. Ensure hdc API token role/ACL (VM.Audit, Datastore.Audit, …) via pveum over SSH.
 * 3. Verify provision templates (LXC ostemplate on each node; QEMU template_vmid in cluster).
 * 4. Ensure NAS storage connections (nas-a, nas-b by default) on each cluster/standalone group.
 * 5. Ensure backup failure notification targets/matchers (provision.notifications).
 * 6. Ensure scheduled backup jobs + backup-* frequency tags for managed guests (provision.backups).
 * 7. Ensure storage replication jobs for managed guests (provision.replication).
 * 8. Ensure HA groups and resources for managed guests (provision.ha).
 * 9. Ensure guest startup order for priority services (provision.startup).
 * 10. Extend local-lvm and ensure extra-disk LVM-thin pools (provision.local_lvm).
 * 11. apt update/dist-upgrade on each hypervisor via SSH public-key auth; sequential reboot if required.
 * 12. Report configured CPU/RAM/disk load per hypervisor (% of node capacity from API).
 * 13. Write markdown report under clumps/infrastructure/proxmox/reports/ in hdc-private when present (unless --no-report).
 *
 * Bootstrap the local `hdc` user on Ubuntu/bootstrap hosts via `ubuntu maintain` or `users bootstrap-hdc` — not from this script.
 *
 * Flags:
 *   --dry-run              Report only; no SSH password changes or template downloads
 *   --no-download          Do not auto-download missing LXC ostemplates
 *   --no-build-qemu        Do not build missing QEMU templates from cloud images
 *   --no-prune             Do not remove unsupported Ubuntu LXC/QEMU templates
 *   --skip-storage           Skip NAS storage ensure (nas-a, nas-b)
 *   --skip-backups           Skip scheduled backup jobs and backup frequency tags (provision.backups)
 *   --skip-backup-verify     Skip backup freshness verification (last vzdump run status/age per job)
 *   --skip-notifications     Skip notification target/matcher ensure (provision.notifications)
 *   --skip-replication       Skip storage replication job ensure (provision.replication)
 *   --skip-ha                Skip HA group/resource ensure (provision.ha)
 *   --skip-startup           Skip guest startup order ensure (provision.startup)
 *   --skip-local-lvm         Skip local-lvm extend and extra-disk pools
 *   --skip-api-token         Skip hdc API token role/ACL ensure (pveum over SSH)
 *   --skip-service-accounts  Skip provision.service_accounts user/token/ACL ensure
 *   --regenerate-service-token <id>   Regenerate API token secret for service account id
 *   --regenerate-service-password <id>  Regenerate user password for service account id
 *   --skip-ssh-keys          Skip installing local SSH keys on hypervisors
 *   --skip-os-updates      Skip apt update/upgrade and reboots on hypervisors
 *   --skip-load-report     Skip configured CPU/RAM/disk load report (stderr); markdown may still collect capacity
 *   --skip-oem-license     Skip OEM Windows SLIC/MSDM probe on hypervisors
 *   --skip-guest-agent     Skip QEMU guest agent config + ping report
 *   --expand-guest-rootfs  Expand running Linux guest root disks in +8G steps until usage is below 50% (opt-in)
 *   --guest-rootfs-threshold <pct>  Used-percent trigger (default 50; config: provision.guest_rootdisk.max_used_percent)
 *   --guest-rootfs-increment-gb <n>  GiB per expansion step (default 8; config: provision.guest_rootdisk.increment_gb)
 *   --skip-host-firewall   Skip Proxmox host firewall (SSH/8006 restriction)
 *   --skip-guest-firewall  Skip Proxmox guest firewall rules on managed vmids
 *   --skip-mail-relay      Skip Postfix satellite (internal mail relay) on hypervisors
 *   --no-report            Do not write markdown report file
 *   --no-discord-notify    Skip Discord #hdc-ops notification for this run
 *   --report <path>        Override markdown report output path
 *   --skip-templates       Skip Ubuntu LTS template verify/build
 *   --migrate --vmid N --target-host <id>  Offline-migrate QEMU guest (early exit)
 *   --repair-console --vmid N              Ubuntu cloud template serial→VGA repair (early exit)
 *   --regen-cloudinit --vmid N [--ipconfig0 …]  Recreate cloud-init drive (early exit)
 */
import { dirname, join } from "node:path";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { stderr as errout } from "node:process";
import { fileURLToPath } from "node:url";

import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { CliExit } from "hdc/cli/lib/cli-exit.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { maybeNotifyOpsDiscordFromProxmoxMaintain } from "hdc/cli/lib/ops-discord-notify.mjs";
import {
  hostOsRebootWaitMsFromConfig,
  runProxmoxHostOsMaintain,
} from "hdc/package/proxmox-host-os-maintain.mjs";
import { runProxmoxMailRelayMaintain } from "hdc/package/proxmox-mail-relay-maintain.mjs";
import { runProxmoxMaintainTemplates } from "hdc/package/proxmox-maintain-templates.mjs";
import { runProxmoxApiTokenMaintain } from "hdc/package/proxmox-api-token-maintain.mjs";
import { runProxmoxServiceAccountMaintain } from "hdc/package/proxmox-service-account-maintain.mjs";
import { runProxmoxStorageMaintain } from "hdc/package/proxmox-storage-maintain.mjs";
import { runProxmoxBackupMaintain } from "hdc/package/proxmox-backup-maintain.mjs";
import { runProxmoxBackupVerify } from "hdc/package/proxmox-backup-verify.mjs";
import { runProxmoxNotificationsMaintain } from "hdc/package/proxmox-notifications-maintain.mjs";
import { runProxmoxReplicationMaintain } from "hdc/package/proxmox-replication-maintain.mjs";
import { runProxmoxHaMaintain } from "hdc/package/proxmox-ha-maintain.mjs";
import { runProxmoxGuestStartupMaintain } from "hdc/package/proxmox-guest-startup-maintain.mjs";
import { runProxmoxGuestTagsMaintain } from "hdc/package/proxmox-guest-tags-maintain.mjs";
import { runProxmoxLocalLvmMaintain } from "hdc/package/proxmox-local-lvm-maintain.mjs";
import { runProxmoxSshKeysMaintain } from "hdc/package/proxmox-ssh-keys-maintain.mjs";
import {
  collectProxmoxCapacityReport,
  runProxmoxHostLoadReport,
} from "hdc/package/proxmox-host-load-report.mjs";
import { runProxmoxOemWindowsLicenseReport } from "hdc/package/proxmox-oem-windows-license.mjs";
import { runProxmoxQemuGuestAgentReport } from "hdc/package/proxmox-qemu-guest-agent.mjs";
import { runProxmoxGuestRootdiskMaintain } from "hdc/package/proxmox-guest-rootdisk-maintain.mjs";
import { runProxmoxHostFirewallMaintain } from "hdc/package/proxmox-host-firewall-maintain.mjs";
import { runProxmoxGuestFirewallMaintain } from "hdc/package/proxmox-guest-firewall-maintain.mjs";
import { isProxmoxConfigObject, isProxmoxHostDown } from "hdc/package/proxmox-config.mjs";
import {
  createMaintainReportContext,
  pushWarning,
  recordStep,
  writeMaintainReportFile,
} from "hdc/package/proxmox-maintain-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[proxmox] maintain: ${line}\n`);
}

/**
 * @param {string} line
 */
function warn(line) {
  errout.write(`[proxmox] maintain: WARN ${line}\n`);
}

/**
 * @param {string} clumpRoot
 * @returns {string[]}
 */
function downHostIdsFromConfig(clumpRoot) {
  try {
    const { data: cfg } = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: "clumps/infrastructure/proxmox/config.example.json",
    });
    if (!isProxmoxConfigObject(cfg) || !Array.isArray(cfg.clusters)) return [];
    /** @type {string[]} */
    const ids = [];
    for (const cl of cfg.clusters) {
      if (!isProxmoxConfigObject(cl) || !Array.isArray(cl.hosts)) continue;
      for (const h of cl.hosts) {
        if (!isProxmoxConfigObject(h)) continue;
        const id = typeof h.id === "string" ? h.id.trim() : "";
        if (id && isProxmoxHostDown(h)) ids.push(id);
      }
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/**
 * @param {string[]} argv
 * @returns {string | undefined}
 */
function reportPathFromArgv(argv) {
  const idx = argv.indexOf("--report");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return undefined;
}

/**
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string[]}
 */
function flagValuesFromArgv(argv, flag) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const val = argv[i + 1];
    if (val && !val.startsWith("--")) out.push(val);
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string | undefined}
 */
function flagValueFromArgv(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) {
    return argv[idx + 1];
  }
  return undefined;
}

async function main() {
  const argv = process.argv.slice(2);

  try {
    const { maybeRunProxmoxMaintainGuestOps } = await import("../lib/proxmox-maintain-guest-ops.mjs");
    const guestOps = await maybeRunProxmoxMaintainGuestOps(argv, clumpRoot);
    if (guestOps.handled) {
      const payload = {
        target: "proxmox",
        verb: "maintain",
        ...(guestOps.result ?? {}),
      };
      if (guestOps.ok === false) process.exitCode = 1;
      errout.write(`[proxmox] maintain: guest op finished (${guestOps.ok ? "ok" : "failed"}).\n`);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
  } catch (e) {
    errout.write(`[proxmox] maintain guest op failed: ${/** @type {Error} */ (e).stack || e}\n`);
    process.exitCode = 1;
    return;
  }

  const skipTemplates = argv.includes("--skip-templates");
  const skipStorage = argv.includes("--skip-storage");
  const skipBackups = argv.includes("--skip-backups");
  const skipBackupVerify = argv.includes("--skip-backup-verify");
  const skipNotifications = argv.includes("--skip-notifications");
  const skipReplication = argv.includes("--skip-replication");
  const skipHa = argv.includes("--skip-ha");
  const skipStartup = argv.includes("--skip-startup");
  const skipGuestTags = argv.includes("--skip-guest-tags");
  const skipLocalLvm = argv.includes("--skip-local-lvm");
  const skipApiToken = argv.includes("--skip-api-token");
  const skipServiceAccounts = argv.includes("--skip-service-accounts");
  const regenerateServiceTokenIds = flagValuesFromArgv(argv, "--regenerate-service-token");
  const regenerateServicePasswordIds = flagValuesFromArgv(argv, "--regenerate-service-password");
  const skipSshKeys = argv.includes("--skip-ssh-keys");
  const skipOsUpdates = argv.includes("--skip-os-updates");
  const skipLoadReport = argv.includes("--skip-load-report");
  const skipOemLicense = argv.includes("--skip-oem-license");
  const skipGuestAgent = argv.includes("--skip-guest-agent");
  const expandGuestRootfs = argv.includes("--expand-guest-rootfs");
  const guestRootfsThreshold = flagValueFromArgv(argv, "--guest-rootfs-threshold");
  const guestRootfsIncrementGb = flagValueFromArgv(argv, "--guest-rootfs-increment-gb");
  const skipHostFirewall = argv.includes("--skip-host-firewall");
  const skipGuestFirewall = argv.includes("--skip-guest-firewall");
  const skipMailRelay = argv.includes("--skip-mail-relay");
  const noReport = argv.includes("--no-report");
  const dryRun = argv.includes("--dry-run");
  const noDownload = argv.includes("--no-download");
  const noBuildQemu = argv.includes("--no-build-qemu");
  const noPrune = argv.includes("--no-prune");
  const reportPathArg = reportPathFromArgv(argv);

  const reportCtx = createMaintainReportContext(argv);
  reportCtx.downHosts = downHostIdsFromConfig(clumpRoot);

  errout.write("[proxmox] maintain: starting (stderr log).\n");

  let exitCode = 0;
  const deps = createNodeCliDeps();
  const vault = createVaultAccess(vaultDepsFromCli(deps));

  const needsVault =
    !skipTemplates ||
    !skipStorage ||
    !skipBackups ||
    !skipReplication ||
    !skipHa ||
    !skipStartup ||
    !skipGuestTags ||
    !skipSshKeys ||
    !skipApiToken ||
    !skipServiceAccounts ||
    !skipLoadReport ||
    expandGuestRootfs ||
    !noReport;

  try {
    if (needsVault) {
      try {
        await vault.unlock({});
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = e.code;
          return;
        }
        throw e;
      }
    }

    if (!skipSshKeys) {
      try {
        const sshResult = await runProxmoxSshKeysMaintain({
          clumpRoot,
          log,
          warn,
          vault,
          dryRun,
          env: deps.env,
          spawnSync: deps.spawnSync,
          readLineQuestion: deps.readLineQuestion,
        });
        if (!sshResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "ssh-keys",
          title: "SSH public keys",
          ran: true,
          ok: sshResult.ok,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`SSH keys maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "ssh-keys",
          title: "SSH public keys",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "ssh-keys",
        title: "SSH public keys",
        ran: false,
        skipReason: "--skip-ssh-keys",
      });
    }

    if (!skipApiToken) {
      try {
        const tokenResult = await runProxmoxApiTokenMaintain({
          clumpRoot,
          log,
          warn,
          vault,
          env: deps.env,
          spawnSync: deps.spawnSync,
          dryRun,
          readLineQuestion: deps.readLineQuestion,
          hostProbe: deps.hostProbe,
        });
        if (!tokenResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "api-token",
          title: "API token ACL",
          ran: true,
          ok: tokenResult.ok,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`API token maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "api-token",
          title: "API token ACL",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "api-token",
        title: "API token ACL",
        ran: false,
        skipReason: "--skip-api-token",
      });
    }

    if (!skipServiceAccounts) {
      try {
        const saResult = await runProxmoxServiceAccountMaintain({
          clumpRoot,
          log,
          warn,
          vault,
          env: deps.env,
          spawnSync: deps.spawnSync,
          dryRun,
          readLineQuestion: deps.readLineQuestion,
          regenerateTokenIds: regenerateServiceTokenIds,
          regeneratePasswordIds: regenerateServicePasswordIds,
        });
        if (!saResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "service-accounts",
          title: "Service account users/tokens",
          ran: true,
          ok: saResult.ok,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`Service account maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "service-accounts",
          title: "Service account users/tokens",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "service-accounts",
        title: "Service account users/tokens",
        ran: false,
        skipReason: "--skip-service-accounts",
      });
    }

    if (!skipTemplates) {
      try {
        const result = await runProxmoxMaintainTemplates({
          clumpRoot,
          log,
          warn,
          vault,
          downloadMissing: !noDownload,
          buildQemuTemplate: !noBuildQemu,
          pruneUnsupported: !noPrune,
          dryRun,
        });
        if (!result.ok) exitCode = 1;
        reportCtx.templateChecks = result.checks ?? [];
        recordStep(reportCtx, {
          id: "templates",
          title: "Ubuntu LTS templates",
          ran: true,
          ok: result.ok,
          notes: [
            noDownload ? "no-download" : "",
            noBuildQemu ? "no-build-qemu" : "",
            noPrune ? "no-prune" : "",
          ].filter(Boolean),
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`template check fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "templates",
          title: "Ubuntu LTS templates",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "templates",
        title: "Ubuntu LTS templates",
        ran: false,
        skipReason: "--skip-templates",
      });
    }

    if (!skipStorage) {
      try {
        const storageResult = await runProxmoxStorageMaintain({
          clumpRoot,
          log,
          warn,
          vault,
          dryRun,
        });
        if (!storageResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "storage",
          title: "NAS storage ensure",
          ran: true,
          ok: storageResult.ok,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`storage maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "storage",
          title: "NAS storage ensure",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "storage",
        title: "NAS storage ensure",
        ran: false,
        skipReason: "--skip-storage",
      });
    }

    if (!skipNotifications) {
      try {
        const notificationsResult = await runProxmoxNotificationsMaintain({
          clumpRoot,
          log,
          warn,
          dryRun,
          vault,
        });
        if (!notificationsResult.ok) exitCode = 1;
        /** @type {string[]} */
        const notificationNotes = [];
        for (const row of notificationsResult.results ?? []) {
          const name = typeof row.name === "string" ? row.name : "?";
          const kind = typeof row.kind === "string" ? row.kind : "item";
          const action = typeof row.action === "string" ? row.action : "?";
          const status = row.ok === false ? "failed" : action;
          notificationNotes.push(`${kind}:${name} ${status}`);
        }
        recordStep(reportCtx, {
          id: "notifications",
          title: "Backup failure notifications",
          ran: true,
          ok: notificationsResult.ok !== false,
          notes: notificationNotes.length ? notificationNotes : undefined,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`notifications maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "notifications",
          title: "Backup failure notifications",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "notifications",
        title: "Backup failure notifications",
        ran: false,
        skipReason: "--skip-notifications",
      });
    }

    if (!skipBackups) {
      try {
        const backupResult = await runProxmoxBackupMaintain({
          clumpRoot,
          repoRoot: repoRoot(),
          log,
          warn,
          dryRun,
          prune: !noPrune,
          vault,
        });
        if (!backupResult.ok) exitCode = 1;
        /** @type {string[]} */
        const backupNotes = [];
        for (const row of backupResult.results ?? []) {
          const id = typeof row.id === "string" ? row.id : row.systemId;
          const action = typeof row.action === "string" ? row.action : "?";
          const profile = typeof row.profile === "string" ? row.profile : "";
          const vmid = row.vmid !== undefined ? String(row.vmid) : "";
          const tag = typeof row.liveTag === "string" ? row.liveTag : typeof row.desiredTag === "string" ? row.desiredTag : "";
          const schedule = typeof row.schedule === "string" ? row.schedule : "";
          const storage = typeof row.storage === "string" ? row.storage : "";
          const status = row.ok === false ? "failed" : action;
          const bits = [`${id ?? "?"} vmid=${vmid}`, profile && `profile=${profile}`, tag && `tag=${tag}`, schedule && `schedule=${schedule}`, storage && `storage=${storage}`, status];
          backupNotes.push(bits.filter(Boolean).join(" "));
        }
        recordStep(reportCtx, {
          id: "backups",
          title: "Scheduled backup jobs",
          ran: true,
          ok: backupResult.ok !== false,
          notes: backupNotes.length ? backupNotes : undefined,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`backup maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "backups",
          title: "Scheduled backup jobs",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "backups",
        title: "Scheduled backup jobs",
        ran: false,
        skipReason: "--skip-backups",
      });
    }

    if (!skipBackupVerify) {
      try {
        const verifyResult = await runProxmoxBackupVerify({
          clumpRoot,
          log,
          warn,
          vault,
        });
        if (!verifyResult.ok) exitCode = 1;
        /** @type {string[]} */
        const verifyNotes = [];
        for (const row of verifyResult.results ?? []) {
          verifyNotes.push(
            `${row.id} vmid=${row.vmid} last=${row.lastRunIso ?? "never"} age=${row.ageHours ?? "?"}h max=${row.maxAgeHours}h ${row.status}`,
          );
        }
        recordStep(reportCtx, {
          id: "backup-verify",
          title: "Backup freshness (last run status/age)",
          ran: !verifyResult.skipped,
          ok: verifyResult.ok !== false,
          skipReason: verifyResult.skipped ? "disabled or no config" : undefined,
          notes: verifyNotes.length ? verifyNotes : undefined,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`backup verify fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "backup-verify",
          title: "Backup freshness (last run status/age)",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "backup-verify",
        title: "Backup freshness (last run status/age)",
        ran: false,
        skipReason: "--skip-backup-verify",
      });
    }

    if (!skipReplication) {
      try {
        const replicationResult = await runProxmoxReplicationMaintain({
          clumpRoot,
          repoRoot: repoRoot(),
          log,
          warn,
          dryRun,
          prune: !noPrune,
          vault,
        });
        if (!replicationResult.ok) exitCode = 1;
        /** @type {string[]} */
        const replicationNotes = [];
        for (const row of replicationResult.results ?? []) {
          const id = typeof row.id === "string" ? row.id : row.systemId;
          const action = typeof row.action === "string" ? row.action : "?";
          const profile = typeof row.profile === "string" ? row.profile : "";
          const vmid = row.vmid !== undefined ? String(row.vmid) : "";
          const target = typeof row.targetHostId === "string" ? row.targetHostId : "";
          const status = row.ok === false ? "failed" : action;
          replicationNotes.push(`${id ?? "?"} vmid=${vmid} target=${target} profile=${profile} ${status}`);
        }
        recordStep(reportCtx, {
          id: "replication",
          title: "Storage replication jobs",
          ran: true,
          ok: replicationResult.ok !== false,
          notes: replicationNotes.length ? replicationNotes : undefined,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`replication maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "replication",
          title: "Storage replication jobs",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "replication",
        title: "Storage replication jobs",
        ran: false,
        skipReason: "--skip-replication",
      });
    }

    if (!skipHa) {
      try {
        const haResult = await runProxmoxHaMaintain({
          clumpRoot,
          repoRoot: repoRoot(),
          log,
          warn,
          dryRun,
          prune: !noPrune,
          vault,
        });
        if (!haResult.ok) exitCode = 1;
        /** @type {string[]} */
        const haNotes = [];
        for (const row of haResult.results ?? []) {
          const kind = typeof row.kind === "string" ? row.kind : "resource";
          const action = typeof row.action === "string" ? row.action : "?";
          const status = row.ok === false ? "failed" : action;
          if (kind === "group") {
            haNotes.push(`group=${row.group ?? "?"} ${status}`);
          } else {
            haNotes.push(`${row.systemId ?? row.sid ?? "?"} sid=${row.sid ?? "?"} ${status}`);
          }
        }
        recordStep(reportCtx, {
          id: "ha",
          title: "HA groups and resources",
          ran: true,
          ok: haResult.ok !== false,
          notes: haNotes.length ? haNotes : undefined,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`HA maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "ha",
          title: "HA groups and resources",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "ha",
        title: "HA groups and resources",
        ran: false,
        skipReason: "--skip-ha",
      });
    }

    if (!skipStartup) {
      try {
        const startupResult = await runProxmoxGuestStartupMaintain({
          clumpRoot,
          repoRoot: repoRoot(),
          log,
          warn,
          dryRun,
          vault,
        });
        if (!startupResult.ok) exitCode = 1;
        /** @type {string[]} */
        const startupNotes = [];
        for (const row of startupResult.results ?? []) {
          const systemId = typeof row.systemId === "string" ? row.systemId : "?";
          const action = typeof row.action === "string" ? row.action : "?";
          const vmid = row.vmid !== undefined ? String(row.vmid) : "";
          const desired =
            row.desired !== null && typeof row.desired === "object" && !Array.isArray(row.desired)
              ? /** @type {Record<string, unknown>} */ (row.desired)
              : null;
          const startup =
            desired && typeof desired.startup === "string" ? desired.startup : "";
          const status = row.ok === false ? "failed" : action;
          startupNotes.push(`${systemId} vmid=${vmid} ${startup} ${status}`);
        }
        recordStep(reportCtx, {
          id: "guest-startup",
          title: "Guest startup order",
          ran: true,
          ok: startupResult.ok !== false,
          notes: startupNotes.length ? startupNotes : undefined,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`guest startup maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "guest-startup",
          title: "Guest startup order",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "guest-startup",
        title: "Guest startup order",
        ran: false,
        skipReason: "--skip-startup",
      });
    }

    if (!skipGuestTags) {
      try {
        const tagsResult = await runProxmoxGuestTagsMaintain({
          clumpRoot,
          repoRoot: repoRoot(),
          log,
          warn,
          dryRun,
          vault,
        });
        if (!tagsResult.ok) exitCode = 1;
        /** @type {string[]} */
        const tagsNotes = [];
        for (const row of tagsResult.results ?? []) {
          const systemId = typeof row.systemId === "string" ? row.systemId : "?";
          const action = typeof row.action === "string" ? row.action : "?";
          const vmid = row.vmid !== undefined ? String(row.vmid) : "";
          const clumpId = typeof row.clumpId === "string" ? row.clumpId : "";
          const status = row.ok === false ? "failed" : action;
          tagsNotes.push(`${systemId} vmid=${vmid} tag=${clumpId} ${status}`);
        }
        recordStep(reportCtx, {
          id: "guest-tags",
          title: "Guest package tags",
          ran: true,
          ok: tagsResult.ok !== false,
          notes: tagsNotes.length ? tagsNotes : undefined,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`guest tags maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "guest-tags",
          title: "Guest package tags",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "guest-tags",
        title: "Guest package tags",
        ran: false,
        skipReason: "--skip-guest-tags",
      });
    }

    if (!skipLocalLvm) {
      try {
        const localLvmResult = await runProxmoxLocalLvmMaintain({
          clumpRoot,
          log,
          warn,
          dryRun,
          env: deps.env,
          spawnSync: deps.spawnSync,
        });
        if (!localLvmResult.ok) exitCode = 1;
        /** @type {string[]} */
        const localLvmNotes = [];
        for (const row of localLvmResult.results ?? []) {
          const hostId = typeof row.hostId === "string" ? row.hostId : "?";
          if (row.skipped) {
            localLvmNotes.push(`${hostId}: skip`);
            continue;
          }
          if (row.error) {
            localLvmNotes.push(`${hostId}: ${row.error}`);
            continue;
          }
          /** @type {string[]} */
          const parts = [];
          if (row.extend && typeof row.extend === "object") {
            const ext = /** @type {{ ok?: boolean; skipped?: boolean }} */ (row.extend);
            if (ext.skipped) parts.push("extend:skip");
            else parts.push(`extend:${ext.ok ? "ok" : "fail"}`);
          }
          if (Array.isArray(row.pools)) {
            for (const p of row.pools) {
              if (!p || typeof p !== "object") continue;
              const po = /** @type {{ storageId?: string; ok?: boolean; dryRun?: boolean }} */ (p);
              const sid = po.storageId ?? "pool";
              if (po.dryRun) parts.push(`${sid}:dry-run`);
              else parts.push(`${sid}:${po.ok ? "ok" : "fail"}`);
            }
          }
          localLvmNotes.push(`${hostId}: ${parts.length ? parts.join("; ") : "ok"}`);
        }
        recordStep(reportCtx, {
          id: "local-lvm",
          title: "Local LVM extend and extra pools",
          ran: true,
          ok: localLvmResult.ok,
          notes: localLvmNotes,
        });
      } catch (e) {
        log(`local-lvm maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
        exitCode = 1;
        recordStep(reportCtx, {
          id: "local-lvm",
          title: "Local LVM extend and extra pools",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "local-lvm",
        title: "Local LVM extend and extra pools",
        ran: false,
        skipReason: "--skip-local-lvm",
      });
    }

    if (!skipOsUpdates) {
      let rebootWaitMs = 5 * 60 * 1000;
      try {
        const { data: cfg } = loadClumpConfigFromClumpRoot(clumpRoot, {
          exampleRel: "clumps/infrastructure/proxmox/config.example.json",
        });
        rebootWaitMs = hostOsRebootWaitMsFromConfig(cfg);
      } catch {
        /* use default */
      }
      try {
        const osResult = await runProxmoxHostOsMaintain({
          clumpRoot,
          log,
          warn,
          dryRun,
          env: deps.env,
          spawnSync: deps.spawnSync,
          rebootWaitMs,
        });
        if (!osResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "host-os",
          title: "Host OS updates",
          ran: true,
          ok: osResult.ok,
        });
      } catch (e) {
        log(`host OS maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
        exitCode = 1;
        recordStep(reportCtx, {
          id: "host-os",
          title: "Host OS updates",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "host-os",
        title: "Host OS updates",
        ran: false,
        skipReason: "--skip-os-updates",
      });
    }

    if (!skipMailRelay) {
      try {
        const mailResult = await runProxmoxMailRelayMaintain({
          clumpRoot,
          log,
          warn,
          dryRun,
          env: deps.env,
          spawnSync: deps.spawnSync,
        });
        reportCtx.mailRelay = mailResult.hosts ?? [];
        if (!mailResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "mail-relay",
          title: "Postfix satellite (mail relay)",
          ran: true,
          ok: mailResult.ok,
        });
      } catch (e) {
        log(`mail relay maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
        exitCode = 1;
        recordStep(reportCtx, {
          id: "mail-relay",
          title: "Postfix satellite (mail relay)",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "mail-relay",
        title: "Postfix satellite (mail relay)",
        ran: false,
        skipReason: "--skip-mail-relay",
      });
    }

    if (!skipOemLicense) {
      try {
        const oemResult = await runProxmoxOemWindowsLicenseReport({
          clumpRoot,
          log,
          warn,
          dryRun,
          env: deps.env,
          spawnSync: deps.spawnSync,
        });
        reportCtx.oemWindowsLicense = oemResult.hosts ?? [];
        if (!oemResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "oem-license",
          title: "OEM Windows license (SLIC/MSDM)",
          ran: true,
          ok: oemResult.ok,
        });
      } catch (e) {
        log(`OEM license report fatal: ${/** @type {Error} */ (e).stack || e}`);
        exitCode = 1;
        recordStep(reportCtx, {
          id: "oem-license",
          title: "OEM Windows license (SLIC/MSDM)",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "oem-license",
        title: "OEM Windows license (SLIC/MSDM)",
        ran: false,
        skipReason: "--skip-oem-license",
      });
    }

    if (!skipGuestAgent) {
      try {
        const gaResult = await runProxmoxQemuGuestAgentReport({
          clumpRoot,
          log,
          warn,
          vault,
        });
        reportCtx.qemuGuestAgent = gaResult.data;
        if (!gaResult.ok) exitCode = 1;
        for (const w of gaResult.data?.warnings ?? []) {
          pushWarning(reportCtx, w);
        }
        recordStep(reportCtx, {
          id: "guest-agent",
          title: "QEMU guest agent",
          ran: true,
          ok: gaResult.ok,
        });
      } catch (e) {
        log(`QEMU guest agent report fatal: ${/** @type {Error} */ (e).stack || e}`);
        exitCode = 1;
        recordStep(reportCtx, {
          id: "guest-agent",
          title: "QEMU guest agent",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "guest-agent",
        title: "QEMU guest agent",
        ran: false,
        skipReason: "--skip-guest-agent",
      });
    }

    if (expandGuestRootfs) {
      /** @type {Record<string, string>} */
      const guestRootdiskFlags = {};
      if (guestRootfsThreshold !== undefined) {
        guestRootdiskFlags["guest-rootfs-threshold"] = guestRootfsThreshold;
      }
      if (guestRootfsIncrementGb !== undefined) {
        guestRootdiskFlags["guest-rootfs-increment-gb"] = guestRootfsIncrementGb;
      }
      try {
        const rootdiskResult = await runProxmoxGuestRootdiskMaintain({
          clumpRoot,
          log,
          warn,
          dryRun,
          env: deps.env,
          vault,
          flags: guestRootdiskFlags,
        });
        reportCtx.guestRootdisk = rootdiskResult;
        if (!rootdiskResult.ok) exitCode = 1;
        for (const w of rootdiskResult.warnings ?? []) {
          pushWarning(reportCtx, w);
        }
        recordStep(reportCtx, {
          id: "guest-rootdisk",
          title: "Guest root disk expansion",
          ran: true,
          ok: rootdiskResult.ok,
        });
      } catch (e) {
        log(`Guest root disk maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
        exitCode = 1;
        recordStep(reportCtx, {
          id: "guest-rootdisk",
          title: "Guest root disk expansion",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "guest-rootdisk",
        title: "Guest root disk expansion",
        ran: false,
        skipReason: "pass --expand-guest-rootfs to run",
      });
    }

    if (!skipHostFirewall) {
      try {
        const hfResult = await runProxmoxHostFirewallMaintain({
          clumpRoot,
          log,
          warn,
          dryRun,
          env: deps.env,
          spawnSync: deps.spawnSync,
        });
        if (!hfResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "host-firewall",
          title: "Host firewall (SSH/8006)",
          ran: true,
          ok: hfResult.ok !== false,
          notes: hfResult.skipped ? [String(hfResult.reason ?? "skipped")] : undefined,
        });
      } catch (e) {
        log(`host firewall maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
        exitCode = 1;
        recordStep(reportCtx, {
          id: "host-firewall",
          title: "Host firewall (SSH/8006)",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "host-firewall",
        title: "Host firewall (SSH/8006)",
        ran: false,
        skipReason: "--skip-host-firewall",
      });
    }

    if (!skipGuestFirewall) {
      try {
        const gfResult = await runProxmoxGuestFirewallMaintain({
          clumpRoot,
          repoRoot: repoRoot(),
          log,
          warn,
          dryRun,
          env: deps.env,
          spawnSync: deps.spawnSync,
        });
        if (!gfResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "guest-firewall",
          title: "Guest firewall (managed vmids)",
          ran: true,
          ok: gfResult.ok !== false,
          notes: gfResult.skipped ? [String(gfResult.reason ?? "skipped")] : undefined,
        });
      } catch (e) {
        log(`guest firewall maintain fatal: ${/** @type {Error} */ (e).stack || e}`);
        exitCode = 1;
        recordStep(reportCtx, {
          id: "guest-firewall",
          title: "Guest firewall (managed vmids)",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "guest-firewall",
        title: "Guest firewall (managed vmids)",
        ran: false,
        skipReason: "--skip-guest-firewall",
      });
    }

    if (!skipLoadReport) {
      try {
        const loadResult = await runProxmoxHostLoadReport({
          clumpRoot,
          log,
          warn,
          vault,
        });
        if (loadResult.data) reportCtx.capacity = loadResult.data;
        if (!loadResult.ok) exitCode = 1;
        recordStep(reportCtx, {
          id: "load-report",
          title: "Configured load report (stderr)",
          ran: true,
          ok: loadResult.ok,
        });
      } catch (e) {
        if (e instanceof CliExit) {
          exitCode = exitCode || e.code;
        } else {
          log(`load report fatal: ${/** @type {Error} */ (e).stack || e}`);
          exitCode = 1;
        }
        recordStep(reportCtx, {
          id: "load-report",
          title: "Configured load report (stderr)",
          ran: true,
          ok: false,
          notes: [String(/** @type {Error} */ (e).message || e)],
        });
      }
    } else {
      recordStep(reportCtx, {
        id: "load-report",
        title: "Configured load report (stderr)",
        ran: false,
        skipReason: "--skip-load-report",
      });
    }
  } finally {
    reportCtx.exitCode = exitCode;

    if (!noReport) {
      if (!reportCtx.capacity) {
        try {
          reportCtx.capacity = await collectProxmoxCapacityReport({
            clumpRoot,
            warn: (line) => pushWarning(reportCtx, line),
            vault,
          });
        } catch (e) {
          pushWarning(
            reportCtx,
            `Capacity collect for markdown failed: ${/** @type {Error} */ (e).message || e}`,
          );
        }
      }

      try {
        const written = writeMaintainReportFile({
          clumpRoot,
          ctx: reportCtx,
          reportPathArg,
          publicRoot: repoRoot(),
        });
        if (written) log(`Wrote maintain report to ${written}`);
      } catch (e) {
        warn(`Failed to write maintain report: ${/** @type {Error} */ (e).message || e}`);
      }
    } else {
      maybeNotifyOpsDiscordFromProxmoxMaintain(reportCtx);
    }
  }

  if (exitCode === 0) log("finished OK.");
  else log("finished with errors.");
  process.exit(exitCode);
}

main();
