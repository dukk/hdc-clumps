#!/usr/bin/env node
/**
 * Re-apply Keepalived configuration; optional package upgrade.
 *
 * Usage: hdc run service keepalived maintain -- [--instance a] [--skip-package-upgrade]
 *        [--director-only] [--real-server-only] [--dry-run]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { syncQemuRootfsOnMaintain } from "hdc/package/qemu-rootfs-resize.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { configureKeepalivedDirector, createConfigureExec } from "hdc/package/keepalived-configure.mjs";
import { configureKeepalivedRealServer } from "hdc/package/keepalived-real-server.mjs";
import { aptUpgradeKeepalivedCommand } from "hdc/package/keepalived-install.mjs";
import { resolveKeepalivedAuthPass } from "hdc/package/keepalived-auth.mjs";
import {
  normalizeKeepalivedConfig,
  resolveKeepalivedDeployments,
  keepalivedGlobalSettings,
  usesNatLbKind,
} from "hdc/package/deployments.mjs";
import { keepalivedPayloadMeta, keepalivedReportExtraSections } from "hdc/package/keepalived-report.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { createKeepalivedVaultAccess } from "hdc/package/vault-deps.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/keepalived/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}
function readCfg() {
  return ensurePackageConfig().data;
}

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 */
function runChecked(exec, cmd) {
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    throw new Error(`${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`);
  }
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: keepalived maintain (stderr log; JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const dryRun = flagGet(flags, "dry-run", "dry_run") !== undefined;
  const skipUpgrade = flagGet(flags, "skip-package-upgrade") !== undefined;

  let normalized;
  let toMaintain;
  try {
    normalized = normalizeKeepalivedConfig(cfg);
    toMaintain = resolveKeepalivedDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const global = keepalivedGlobalSettings(normalized);
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const vault = createKeepalivedVaultAccess();
  await vault.unlock({});
  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
  const authPass = await resolveKeepalivedAuthPass({ global, vault, log: logLine });
  const enableNatForward = usesNatLbKind(normalized.virtualServers);
  const log = provisionLogFromConsole(console);

  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const deployment of toMaintain) {
    const cfgSsh = deployment.configure;
    const ssh = isObject(cfgSsh) && isObject(cfgSsh.ssh) ? cfgSsh.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" ? ssh.host : "";
    if (!host) {
      results.push({ ok: false, system_id: deployment.systemId, message: "missing ssh host" });
      continue;
    }

    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} at ${user}@${host} …\n`);

    if (dryRun) {
      results.push({
        ok: true,
        system_id: deployment.systemId,
        deployment_kind: deployment.deploymentKind,
        dry_run: true,
      });
      continue;
    }

    /** @type {Record<string, unknown> | undefined} */
    let diskResize;
    /** @type {Record<string, unknown> | undefined} */
    let baseline;

    try {
      const exec = createConfigureExec("ssh", { user, host });

      if (deployment.deploymentKind === "director" && deployment.mode === "proxmox-qemu") {
        diskResize = await syncQemuRootfsOnMaintain({
          proxmoxPackageRoot: proxmoxRoot,
          deployment,
          flags,
          log: logLine,
        });
      }

      if (!skipUpgrade && deployment.deploymentKind === "director") {
        runChecked(exec, aptUpgradeKeepalivedCommand());
      }

      /** @type {Record<string, unknown>} */
      let configure;
      if (deployment.deploymentKind === "director") {
        configure = await configureKeepalivedDirector({
          exec,
          log,
          global,
          director: deployment,
          vrrpInstances: normalized.vrrpInstances,
          virtualServers: normalized.virtualServers,
          authPass,
          skipPackageInstall: false,
          restartService: true,
          enableNatForward,
        });
      } else {
        configure = await configureKeepalivedRealServer({
          exec,
          log,
          deployment,
          virtualServers: normalized.virtualServers,
          vrrpInstances: normalized.vrrpInstances,
        });
      }

      if (deployment.deploymentKind === "director" && deployment.mode === "proxmox-qemu") {
        baseline = await ensureGuestLinuxBaseline({
          exec,
          log,
          flags,
          vaultAccess,
          deployment: { system_id: deployment.systemId, mode: deployment.mode, proxmox: deployment.proxmox },
          proxmoxPackageRoot: proxmoxRoot,
          clumpId: target,
        });
      }

      results.push({
        ok: baseline ? baseline.ok !== false : true,
        system_id: deployment.systemId,
        deployment_kind: deployment.deploymentKind,
        configure,
        disk_resize: diskResize,
        ...guestBaselineResultFields(baseline),
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({
        ok: false,
        system_id: deployment.systemId,
        deployment_kind: deployment.deploymentKind,
        message: msg,
      });
    }
  }

  const ok = results.every((r) => r.ok !== false);
  const payload = {
    ok,
    target,
    verb,
    dry_run: dryRun,
    keepalived: keepalivedPayloadMeta(global),
    results,
  };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: logLine,
    extraSections: keepalivedReportExtraSections,
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
