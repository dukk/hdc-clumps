#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Re-apply Splunk configuration; optional package upgrade.
 *
 * Usage: hdc run service splunk maintain -- [--instance a] [--skip-package-upgrade] [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { configureSplunkStandalone, createConfigureExec } from "hdc/package/splunk-configure.mjs";
import {
  dataDiskGbFromDeployment,
  normalizeSplunkConfig,
  resolveSplunkDeployments,
  splunkGlobalSettings,
  splunkSettingsForDeployment,
} from "hdc/package/deployments.mjs";
import { instanceLetterFromSystemId, adminPasswordVaultKey } from "hdc/package/inventory.mjs";
import { createSplunkVaultAccess } from "hdc/package/vault-deps.mjs";
import { splunkReportExtraSections } from "hdc/package/splunk-report.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/splunk/config.example.json";
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
function tryCfg() {
  return tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Splunk maintain (stderr log; JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const skipUpgrade = flagGet(flags, "skip-package-upgrade") !== undefined;

  let normalized;
  let toMaintain;
  try {
    normalized = normalizeSplunkConfig(cfg);
    toMaintain = resolveSplunkDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  let global;
  try {
    global = splunkGlobalSettings(normalized);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const vault = createSplunkVaultAccess();
  await vault.unlock({});

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
    const letter = instanceLetterFromSystemId(deployment.systemId);
    const spBlock = isObject(normalized.splunk) ? normalized.splunk : {};
    const adminKey = adminPasswordVaultKey(spBlock, letter);
    const adminPassword = String(
      await vault.getSecret(adminKey, { promptLabel: `vault secret ${adminKey}` }),
    ).trim();
    if (!adminPassword) {
      results.push({ ok: false, system_id: deployment.systemId, message: `missing ${adminKey}` });
      continue;
    }

    const exec = createConfigureExec("ssh", { user, host });
    const local = splunkSettingsForDeployment(deployment, global);

    try {
      const configure = await configureSplunkStandalone({
        exec,
        log,
        global,
        local,
        adminPassword,
        skipPackageUpgrade: skipUpgrade,
        dataDiskGb: dataDiskGbFromDeployment(deployment),
      });
      const baseline = await ensureGuestLinuxBaseline({ exec, log, flags, vaultAccess, deployment, proxmoxPackageRoot: proxmoxRoot });
      const rowOk = configure.ok && baseline.admin_user?.ok !== false && baseline.clamav?.ok !== false;
      results.push({
        ok: rowOk,
        system_id: deployment.systemId,
        configure,
        ...guestBaselineResultFields(baseline),
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  const payload = { ok, target, verb, results, generated_at: new Date().toISOString() };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    extraSections: splunkReportExtraSections,
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

