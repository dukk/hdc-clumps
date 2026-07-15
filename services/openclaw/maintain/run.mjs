#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Maintain OpenClaw: re-push config, optional upgrade, guest Linux baseline.
 *
 * Usage: hdc run service openclaw maintain -- [--instance a | --system-id vm-openclaw-a]
 *        [--skip-upgrade] [--skip-clamav] …
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import {
  loadClumpConfigFromClumpRoot,
  tryLoadClumpConfigFromClumpRoot,
} from "hdc/package/clump-run-config.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveOpenclawDeployments } from "hdc/package/deployments.mjs";
import { installOpenclawInQemu } from "hdc/package/openclaw-install.mjs";
import { createOpenclawVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolveOpenclawSecrets } from "hdc/package/vault-secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/openclaw/config.example.json";
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
 * @param {ReturnType<typeof resolveOpenclawDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof createOpenclawVaultAccess>} vault
 */
async function maintainOne(deployment, flags, vault) {
  const { systemId, mode, proxmox, configure, install, openclaw } = deployment;
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

  errout.write(`[hdc] ${target} ${verb}: resolving vault secrets for ${systemId} …\n`);
  const secrets = await resolveOpenclawSecrets(vault, openclaw);

  const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
  errout.write(
    `[hdc] ${target} ${verb}: re-applying OpenClaw on ${systemId}${skipUpgrade ? "" : " (with upgrade)"} …\n`,
  );
  try {
    const installResult = await installOpenclawInQemu({
      exec,
      log,
      install,
      openclaw,
      guestEnv: secrets.guestEnv,
      upgradeOpts: { upgrade: !skipUpgrade },
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
    vaultAccess: vault,
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
  Object.assign(result, {
    guest_resources: baseline.guest_resources,
    hdc_user: baseline.hdc_user,
    admin_user: baseline.admin_user,
    clamav: baseline.clamav,
    clamav_scan_schedule: baseline.clamav_scan_schedule,
    unattended_upgrades: baseline.unattended_upgrades,
    crowdsec_agent: baseline.crowdsec_agent,
    wazuh_agent: baseline.wazuh_agent,
    mail_relay: baseline.mail_relay,
    root_login_disabled: baseline.root_login_disabled,
  });
  if (!baseline.ok) {
    return { ...result, ok: false, message: "guest baseline failed" };
  }

  return result;
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: OpenClaw maintain (stderr log; JSON on stdout).\n`);

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
  const vault = createOpenclawVaultAccess();
  await vault.unlock({});

  let deployments;
  try {
    deployments = resolveOpenclawDeployments(cfg, flags);
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
      results.push(await maintainOne(deployment, flags, vault));
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
