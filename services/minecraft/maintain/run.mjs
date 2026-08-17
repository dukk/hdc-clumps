/**
 * Maintain Minecraft: re-apply Paper/Geyser install, guest Linux baseline.
 *
 * Usage: hdc run service minecraft maintain -- [--instance a | --system-id vm-minecraft-a]
 *        [--skip-upgrade] [--dry-run] [--skip-clamav] [--clamav-profile lean|standard|full]
 *        [--skip-resources] [--skip-disk-resize] [--skip-lists-import]
 *        [--skip-plugin-configs] [--skip-app-dump] [--no-reboot] [--reboot]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import {
  loadClumpConfigFromClumpRoot,
  tryLoadClumpConfigFromClumpRoot,
} from "hdc/package/clump-run-config.mjs";
import { syncQemuRootfsOnMaintain } from "hdc/package/qemu-rootfs-resize.mjs";
import {
  ensureAppDumpSchedule,
  minecraftAppDumpOnCalendar,
  minecraftDumpCommands,
  minecraftDumpPruneCommands,
} from "hdc/package/app-dump-schedule.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveMinecraftDeployments } from "hdc/package/deployments.mjs";
import { installMinecraftInQemu } from "hdc/package/minecraft-install.mjs";
import { importMinecraftListsFromLive } from "hdc/package/minecraft-lists-import.mjs";
import { applyMinecraftPluginConfigsToGuest } from "hdc/package/minecraft-plugin-configs.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/minecraft/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string; resolved?: import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile } | null} */
let _pkgConfig = null;

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: CLUMP_CONFIG_EXAMPLE,
    });
  }
  return _pkgConfig;
}

const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

function readCfg() {
  return ensurePackageConfig().data;
}

function reloadPackageConfig() {
  _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
  });
  return _pkgConfig;
}

/**
 * @param {ReturnType<typeof resolveMinecraftDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 */
async function maintainOne(deployment, flags, vaultAccess) {
  const { systemId, mode, proxmox, configure, install, minecraft } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  const log = provisionLogFromConsole(console);

  if (mode !== "proxmox-qemu") {
    return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  }

  const sshCfg =
    configure && typeof configure === "object" && configure.ssh && typeof configure.ssh === "object"
      ? configure.ssh
      : {};
  const px = proxmox && typeof proxmox === "object" ? proxmox : {};
  const q = px.qemu && typeof px.qemu === "object" ? px.qemu : {};
  const sshUser = resolveGuestSshUser(sshCfg.user);
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];
  if (!sshHost) {
    return { ok: false, system_id: systemId, message: "configure.ssh.host or proxmox.qemu.ip required" };
  }

  /** @type {Record<string, unknown>} */
  const result = { ok: true, system_id: systemId, mode };

  errout.write(`[hdc] ${target} ${verb}: disk resize check on ${systemId} …\n`);
  try {
    const diskResize = await syncQemuRootfsOnMaintain({
      proxmoxPackageRoot: proxmoxRoot,
      deployment: {
        mode,
        hostname: deployment.hostname,
        system_id: systemId,
        proxmox,
        configure,
      },
      flags,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
    result.disk_resize = diskResize;
    if (diskResize.ok === false) {
      return { ...result, ok: false, message: diskResize.message || "disk resize failed" };
    }
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${systemId} disk resize failed: ${msg}\n`);
    return { ...result, ok: false, message: msg };
  }

  const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });

  errout.write(`[hdc] ${target} ${verb}: re-applying Paper install on ${systemId} …\n`);
  try {
    const say = exec.run(
      "/usr/local/sbin/hdc-minecraft-rcon say Performance maintenance: brief restart shortly...",
      { capture: true },
    );
    if (say.status !== 0) {
      errout.write(
        `[hdc] ${target} ${verb}: player warn skipped (${(say.stderr || say.stdout || "rcon failed").trim()})\n`,
      );
    }
    const installResult = await installMinecraftInQemu({
      exec,
      log,
      install,
      minecraft,
      flags: { skipUpgrade },
    });
    result.install = installResult;
  } catch (e) {
    return {
      ok: false,
      system_id: systemId,
      message: String(/** @type {Error} */ (e).message || e),
    };
  }

  errout.write(`[hdc] ${target} ${verb}: guest baseline on ${systemId} …\n`);
  /** @type {Record<string, string>} */
  const baselineFlags = { ...flags };
  if (minecraft.clamavProfile) {
    baselineFlags["clamav-profile"] = minecraft.clamavProfile;
    errout.write(
      `[hdc] ${target} ${verb}: ClamAV profile override ${minecraft.clamavProfile} from config\n`,
    );
  }
  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags: baselineFlags,
    vaultAccess,
    deployment: {
      systemId,
      mode,
      proxmox,
      configure,
      install,
      raw: deployment.raw,
    },
    proxmoxPackageRoot: proxmoxRoot,
  });
  Object.assign(result, guestBaselineResultFields(baseline));
  if (!baseline.ok) {
    return { ...result, ok: false, message: "guest baseline failed" };
  }

  const backup = minecraft.backup || { enabled: true, intervalHours: 6, retainDaily: 7 };
  if (backup.enabled === false) {
    result.app_dump = { ok: true, skipped: true, message: "minecraft.backup.enabled=false" };
  } else {
    errout.write(`[hdc] ${target} ${verb}: ensuring world dump timer on ${systemId} …\n`);
    const appDump = ensureAppDumpSchedule({
      exec,
      log,
      flags,
      spec: {
        systemId,
        name: "minecraft",
        dumpCommands: minecraftDumpCommands(minecraft.installDir),
        pruneCommands: minecraftDumpPruneCommands(backup.retainDaily),
        onCalendar: minecraftAppDumpOnCalendar(systemId, backup.intervalHours),
        randomizedDelaySec: 300,
        retainDays: backup.retainDaily,
      },
    });
    result.app_dump = appDump;
    if (!appDump.ok) {
      return { ...result, ok: false, message: appDump.message || "app dump schedule failed" };
    }
  }

  // After QEMU CPU/RAM stop-start: BlueMap rewrites plugin.conf on first boot.
  const skipPluginConfigs =
    flagGet(flags, "skip-plugin-configs", "skip_plugin_configs") !== undefined;
  const dryRun = flagGet(flags, "dry-run", "dry_run") !== undefined;
  if (skipPluginConfigs) {
    result.plugin_configs = { ok: true, skipped: true, message: "--skip-plugin-configs" };
  } else {
    errout.write(`[hdc] ${target} ${verb}: applying plugin-configs on ${systemId} …\n`);
    try {
      result.plugin_configs = applyMinecraftPluginConfigsToGuest({
        resolved: ensurePackageConfig().resolved,
        cfg: readCfg(),
        deployment,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
        dryRun,
      });
      if (result.plugin_configs.ok === false) {
        return {
          ...result,
          ok: false,
          message: result.plugin_configs.message || "plugin-configs apply failed",
        };
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${systemId} plugin-configs failed: ${msg}\n`);
      return { ...result, ok: false, message: msg, plugin_configs: { ok: false, message: msg } };
    }
  }

  return result;
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Paper Minecraft maintain (stderr log; JSON on stdout).\n`);

  const cfgLoad = tryLoadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
  });
  if (!cfgLoad) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  _pkgConfig = cfgLoad;
  errout.write(`[hdc] ${target} ${verb}: config ${cfgLoad.source}\n`);

  let cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});

  /** @type {Record<string, unknown>[]} */
  const listImports = [];
  const skipListsImport = flagGet(flags, "skip-lists-import", "skip_lists_import") !== undefined;

  let deployments;
  try {
    deployments = resolveMinecraftDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!skipListsImport) {
    for (const deployment of deployments) {
      errout.write(`[hdc] ${target} ${verb}: importing whitelist/ops from ${deployment.systemId} …\n`);
      try {
        const imported = importMinecraftListsFromLive({
          resolved: ensurePackageConfig().resolved,
          cfg,
          deployment,
          log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
          mergeWithConfig: true,
        });
        listImports.push({ system_id: deployment.systemId, ...imported });
        if (imported.ok === false) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, target, verb, list_imports: listImports, message: "lists import failed" }, null, 2)}\n`,
          );
          process.exitCode = 1;
          return;
        }
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        errout.write(`[hdc] ${target} ${verb}: lists import failed: ${msg}\n`);
        process.stdout.write(
          `${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`,
        );
        process.exitCode = 1;
        return;
      }
    }
    cfg = reloadPackageConfig().data;
    try {
      deployments = resolveMinecraftDeployments(cfg, flags);
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
      process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    listImports.push({ ok: true, skipped: true, message: "--skip-lists-import" });
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainOne(deployment, flags, vaultAccess));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok);
  const payload = { ok, target, verb, count: results.length, list_imports: listImports, results };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
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
