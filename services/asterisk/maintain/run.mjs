#!/usr/bin/env node
/**
 * Maintain Asterisk: re-push PJSIP/dialplan config, optional apt upgrade, guest baseline.
 *
 * Usage: hdc run service asterisk maintain -- [--instance a | --system-id asterisk-a]
 *        [--skip-package-upgrade] [--skip-clamav] [--skip-admin-user]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { syncQemuRootfsOnMaintain } from "hdc/package/qemu-rootfs-resize.mjs";

import { resolveAsteriskDeployments } from "hdc/package/deployments.mjs";
import {
  configureAsteriskServer,
  maintainAsteriskInCt,
  resolveConfigureExec,
} from "hdc/package/asterisk-configure.mjs";
import { resolvePveSshForHost } from "hdc/package/asterisk-install.mjs";
import { sipPort, twilioEnabled } from "hdc/package/asterisk-render.mjs";
import { createAsteriskVaultAccess, resolveAsteriskSecrets } from "hdc/package/asterisk-vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/asterisk/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolveAsteriskDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {{ username: string; password: string; endpointPasswords: Record<string, string> }} secrets
 * @param {ReturnType<typeof createAsteriskVaultAccess>} vaultAccess
 */
async function maintainOne(deployment, flags, secrets, vaultAccess) {
  const { systemId, mode, asterisk } = deployment;
  const skipPackageUpgrade = flagGet(flags, "skip-package-upgrade", "skip_package_upgrade") !== undefined;

  errout.write(`[hdc] ${target} ${verb}: ${systemId} mode ${mode} …\n`);

  /** @type {Record<string, unknown>} */
  let configureResult = { ok: false };
  /** @type {Record<string, unknown> | null} */
  let diskResize = null;

  if (mode === "proxmox-lxc") {
    const px = deployment.proxmox;
    if (!isObject(px)) {
      return { ok: false, system_id: systemId, message: "bad proxmox config" };
    }
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    if (!hostId || !Number.isFinite(vmid) || vmid <= 0) {
      return { ok: false, system_id: systemId, message: "missing host_id or vmid" };
    }
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    configureResult = await maintainAsteriskInCt(
      pveSsh.user,
      pveSsh.host,
      vmid,
      asterisk,
      secrets,
      { skipPackageUpgrade },
    );
  } else if (mode === "proxmox-qemu") {
    if (!skipPackageUpgrade) {
      diskResize = await syncQemuRootfsOnMaintain({
        proxmoxPackageRoot: proxmoxRoot,
        deployment: deployment.raw,
        flags,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
    }
    const exec = resolveConfigureExec(deployment, proxmoxRoot);
    configureResult = await configureAsteriskServer({
      exec,
      asterisk,
      secrets,
      skipInstall: false,
      skipPackageUpgrade,
      restartService: true,
    });
  } else if (mode === "configure-only") {
    const exec = resolveConfigureExec(deployment, proxmoxRoot);
    configureResult = await configureAsteriskServer({
      exec,
      asterisk,
      secrets,
      skipInstall: true,
      skipPackageUpgrade: true,
      restartService: true,
    });
  } else {
    return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  }

  errout.write(`[hdc] ${target} ${verb}: guest baseline on ${systemId} …\n`);
  const log = provisionLogFromConsole(console);
  const exec = resolveConfigureExec(deployment, proxmoxRoot);
  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags,
    vaultAccess,
    deployment: deployment.raw,
    proxmoxPackageRoot: proxmoxRoot,
  });

  return {
    ok: configureResult.ok !== false && baseline.admin_user?.ok !== false,
    system_id: systemId,
    mode,
    sip_port: sipPort(asterisk),
    twilio_enabled: twilioEnabled(asterisk),
    configure: configureResult,
    disk_resize: diskResize,
    skip_package_upgrade: skipPackageUpgrade,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Asterisk maintain (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolveAsteriskDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const vaultAccess = createAsteriskVaultAccess();
  await vaultAccess.unlock({});

  const results = [];
  for (const deployment of deployments) {
    try {
      const secrets = await resolveAsteriskSecrets(vaultAccess, deployment.asterisk);
      results.push(await maintainOne(deployment, flags, secrets, vaultAccess));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok !== false);
  const payload = { ok, target, verb, count: results.length, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
