#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Maintain Minecraft: re-apply Paper/Geyser install, guest Linux baseline.
 *
 * Usage: hdc run service minecraft maintain -- [--instance a | --system-id vm-minecraft-a]
 *        [--skip-upgrade] [--dry-run] [--skip-clamav] [--skip-admin-user]
 *        [--skip-resources] [--no-reboot] [--reboot]
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
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveMinecraftDeployments } from "hdc/package/deployments.mjs";
import { installMinecraftInQemu } from "hdc/package/minecraft-install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/minecraft/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
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

  const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });

  errout.write(`[hdc] ${target} ${verb}: re-applying Paper install on ${systemId} …\n`);
  try {
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
  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags,
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

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});

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
  const payload = { ok, target, verb, count: results.length, results };
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
