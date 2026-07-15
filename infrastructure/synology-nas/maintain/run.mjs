#!/usr/bin/env node
/**
 * Synology NAS maintain: SSH bootstrap, DSM upgrade, package upgrades, health report.
 *
 * Usage: hdc run infrastructure synology-nas maintain --
 *   [--instance a|b] [--system-id nas-a]
 *   [--skip-dsm-upgrade] [--skip-package-upgrade] [--skip-ssh-keys] [--skip-docker-ensure]
 *   [--dry-run] [--no-report]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";
import { spawnSync } from "node:child_process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { resolveSynologyDeployments } from "hdc/package/deployments.mjs";
import { runSynologyMaintainForHost } from "hdc/package/synology-maintain.mjs";
import { synologyReportExtraSections } from "hdc/package/synology-report.mjs";
import { resolveSynologySshAuth, sshTargetFromDeployment } from "hdc/package/synology-ssh.mjs";
import { createSynologyVaultAccess } from "hdc/package/vault-deps.mjs";
import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/synology-nas/config.example.json";
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

const root = repoRoot();

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
}

/**
 * @param {string} line
 */
function warn(line) {
  errout.write(`[hdc] ${target} ${verb}: WARN ${line}\n`);
}

async function main() {
  log("Synology NAS maintain (stderr log; JSON on stdout).");

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const dryRun = flags["dry-run"] !== undefined;
  const skipDsm = flags["skip-dsm-upgrade"] !== undefined;
  const skipPackages = flags["skip-package-upgrade"] !== undefined;
  const skipSshKeys = flags["skip-ssh-keys"] !== undefined;
  const skipDockerEnsure = flags["skip-docker-ensure"] !== undefined;

  let deployments;
  try {
    deployments = resolveSynologyDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const deps = createNodeCliDeps();
  const vault = createSynologyVaultAccess();
  await vault.unlock({});
  const { publicKeyLines, identities } = discoverLocalSshMaterial();

  if (!publicKeyLines.length && !skipSshKeys) {
    warn("no ~/.ssh public keys — SSH bootstrap will need password-only access.");
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const deployment of deployments) {
    const sshTarget = sshTargetFromDeployment(deployment, process.env);
    log(`${deployment.systemId}: starting maintain at ${sshTarget.user}@${sshTarget.host} …`);

    const auth = dryRun
      ? { mode: /** @type {const} */ ("pubkey"), password: null }
      : await resolveSynologySshAuth({
          target: sshTarget,
          vault,
          spawnSync,
          env: process.env,
          identities,
          readLineQuestion: deps.readLineQuestion,
          warn,
          dryRun: false,
        });

    const rebootWaitMs = (deployment.maintain.rebootWaitSeconds ?? 600) * 1000;

    const hostResult = await runSynologyMaintainForHost({
      deployment,
      target: sshTarget,
      auth,
      spawnSync,
      env: process.env,
      identities,
      publicKeyLines,
      dryRun,
      skipDsm,
      skipPackages,
      skipSshKeys,
      skipDockerEnsure,
      log,
      warn,
      vault,
      readLineQuestion: deps.readLineQuestion,
      rebootWaitMs,
    });

    results.push(hostResult);
    if (!hostResult.ok) {
      warn(`${deployment.systemId}: ${hostResult.message ?? "maintain failed"}`);
    } else {
      log(`${deployment.systemId}: maintain finished OK.`);
    }
  }

  const ok = results.length > 0 && results.every((r) => r.ok === true);
  const payload = {
    ok,
    target,
    verb,
    dry_run: dryRun,
    results,
    generated_at: new Date().toISOString(),
  };

  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log,
    extraSections: synologyReportExtraSections,
  });

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  warn(`fatal: ${msg}`);
  process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
  process.exit(1);
});
