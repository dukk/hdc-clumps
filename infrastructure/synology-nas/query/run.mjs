#!/usr/bin/env node
/**
 * Synology NAS health query (DSM version, volumes, RAID, disks).
 *
 * Usage: hdc run infrastructure synology-nas query -- [--instance a|b] [--system-id nas-a]
 *        Includes docker ps container list under health.docker.containers when Docker CLI is present.
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { spawnSync } from "node:child_process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { resolveSynologyDeployments } from "hdc/package/deployments.mjs";
import { collectSynologyHealth } from "hdc/package/synology-query-remote.mjs";
import { synologyReportExtraSections } from "hdc/package/synology-report.mjs";
import {
  discoverLocalSshMaterial,
  sshReachableWithPubkey,
} from "hdc/cli/lib/ssh-host-access.mjs";
import {
  resolveSynologySshAuth,
  sshTargetFromDeployment,
} from "hdc/package/synology-ssh.mjs";
import { createSynologyVaultAccess } from "hdc/package/vault-deps.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


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

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Synology NAS health (stderr log; JSON on stdout).\n`);

  const argv = process.argv.slice(2);
  const { maybeRunSynologyHardwareImport } = await import("../lib/synology-hardware-import.mjs");
  const hardwareImport = await maybeRunSynologyHardwareImport(argv, clumpRoot);
  if (hardwareImport) {
    const payload = {
      ok: hardwareImport.ok !== false,
      target,
      verb,
      ...hardwareImport,
      generated_at: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = payload.ok ? 0 : 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(argv);
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
  const { identities } = discoverLocalSshMaterial();

  /** @type {Record<string, unknown>[]} */
  const nodes = [];

  for (const deployment of deployments) {
    const sshTarget = sshTargetFromDeployment(deployment, process.env);
    errout.write(
      `[hdc] ${target} ${verb}: ${deployment.systemId} at ${sshTarget.user}@${sshTarget.host} …\n`,
    );

    const auth = await resolveSynologySshAuth({
      target: sshTarget,
      vault,
      spawnSync,
      env: process.env,
      identities,
      readLineQuestion: deps.readLineQuestion,
      warn: (line) => errout.write(`[hdc] ${target} ${verb}: WARN ${line}\n`),
      dryRun: false,
    });

    if (!auth) {
      nodes.push({
        system_id: deployment.systemId,
        ok: false,
        message: "SSH authentication failed",
      });
      continue;
    }

    if (!sshReachableWithPubkey(sshTarget, spawnSync, process.env, identities) && auth.mode === "password") {
      errout.write(`[hdc] ${target} ${verb}: using password auth for ${deployment.systemId}\n`);
    }

    const collected = collectSynologyHealth({
      target: sshTarget,
      auth,
      spawnSync,
      env: process.env,
      identities,
    });

    const raidDegraded = collected.health?.raid?.degraded === true;
    nodes.push({
      system_id: deployment.systemId,
      host: sshTarget.host,
      ok: collected.ok && !raidDegraded,
      message: collected.message,
      health: collected.health,
      raid_degraded: raidDegraded,
    });
  }

  const ok = nodes.length > 0 && nodes.every((n) => n.ok === true);
  const payload = {
    ok,
    target,
    verb,
    nodes,
    generated_at: new Date().toISOString(),
  };

  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    extraSections: synologyReportExtraSections,
  });

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  errout.write(`[hdc] ${target} ${verb}: fatal: ${msg}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
  process.exit(1);
});
