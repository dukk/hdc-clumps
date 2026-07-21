/**
 * Import Synology NAS hardware into operations/inventory/systems/nas-*.json.
 */
import { spawnSync } from "node:child_process";
import { stderr as errout } from "node:process";

import { discoverLocalSshMaterial, sshReachableWithPubkey } from "hdc/cli/lib/ssh-host-access.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { repoRoot as defaultRepoRoot } from "hdc/cli/paths.mjs";
import { upsertPhysicalSystemHardware } from "hdc/package/hardware-inventory.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { hardwareCommand, parseHardwareOutput } from "hdc/clump/services/meshcentral/lib/meshcentral-ops.mjs";
import { resolveSynologyDeployments } from "./deployments.mjs";
import {
  resolveSynologySshAuth,
  sshTargetFromDeployment,
  synologyRemoteExec,
} from "./synology-ssh.mjs";
import { createSynologyVaultAccess } from "./vault-deps.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

/**
 * @param {object} opts
 * @param {string} opts.publicRoot
 * @param {string} opts.clumpRoot
 * @param {unknown} opts.cfg
 * @param {Record<string, string>} opts.flags
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.yes]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof spawnSync} [opts.spawnSync]
 * @param {(line: string) => void} [opts.log]
 * @param {(line: string) => void} [opts.warn]
 */
export async function importSynologyHardware(opts) {
  const {
    publicRoot,
    clumpRoot,
    cfg,
    flags,
    dryRun = false,
    yes = false,
    env = process.env,
    spawnSync: spawn = spawnSync,
    log = () => {},
    warn = () => {},
  } = opts;

  if (!yes && !dryRun) {
    return { ok: false, message: "query --import-hardware requires --yes (or --dry-run)", written: [] };
  }

  let deployments;
  try {
    deployments = resolveSynologyDeployments(cfg, flags);
  } catch (e) {
    return { ok: false, message: String(/** @type {Error} */ (e).message || e), written: [] };
  }

  const vault = createSynologyVaultAccess();
  await vault.unlock({});
  const { identities } = discoverLocalSshMaterial();
  const deps = createNodeCliDeps();

  /** @type {{ id: string; rel: string; created: boolean; hardware_count: number }[]} */
  const written = [];
  /** @type {string[]} */
  const errors = [];

  for (const deployment of deployments) {
    const sshTarget = sshTargetFromDeployment(deployment, env);
    log(`${deployment.systemId} at ${sshTarget.user}@${sshTarget.host} …`);

    const auth = await resolveSynologySshAuth({
      target: sshTarget,
      vault,
      spawnSync: spawn,
      env,
      identities,
      readLineQuestion: deps.readLineQuestion,
      warn: (line) => warn(`${deployment.systemId}: ${line}`),
      dryRun: false,
    });

    if (!auth) {
      errors.push(`${deployment.systemId}: SSH authentication failed`);
      continue;
    }

    if (!sshReachableWithPubkey(sshTarget, spawn, env, identities) && auth.mode === "password") {
      log(`${deployment.systemId}: using password auth`);
    }

    /** @type {Record<string, unknown>[]} */
    let hardware = [];
    if (!dryRun) {
      const hwScript = hardwareCommand("linux");
      const execResult = synologyRemoteExec(
        {
          target: sshTarget,
          auth,
          spawnSync: spawn,
          env,
          identities,
          timeoutMs: 90_000,
        },
        hwScript,
      );
      const out = String(execResult.stdout || "");
      if (execResult.status === 0) {
        const parsed = parseHardwareOutput(out);
        if (parsed.ok) hardware = parsed.hardware;
        else {
          warn(`${deployment.systemId}: hardware parse failed: ${parsed.message}`);
          errors.push(`${deployment.systemId}: ${parsed.message}`);
        }
      } else {
        const msg = `hardware SSH failed (exit ${execResult.status})`;
        warn(`${deployment.systemId}: ${msg}`);
        errors.push(`${deployment.systemId}: ${msg}`);
      }
    }

    const accessNode = {
      name: "primary",
      ip: sshTarget.host,
    };

    const result = upsertPhysicalSystemHardware({
      publicRoot,
      systemId: deployment.systemId,
      hardware,
      source: "synology-nas",
      accessNode,
      tags: ["synology-nas", "nas"],
      automationTargets: ["synology-nas"],
      dryRun,
      log,
    });
    written.push({
      id: result.id,
      rel: result.rel,
      created: result.created,
      hardware_count: hardware.length,
    });
  }

  return {
    ok: errors.length === 0,
    written,
    errors,
    dry_run: dryRun,
  };
}

/**
 * @param {string[]} argv
 * @param {string} clumpRoot
 * @returns {Promise<object | null>}
 */
export async function maybeRunSynologyHardwareImport(argv, clumpRoot) {
  const flags = parseArgvFlags(argv);
  if (flagGet(flags, "import-hardware", "import_hardware") === undefined) return null;

  const yes = flagGet(flags, "yes") !== undefined;
  const dryRun = flagGet(flags, "dry-run", "dry_run") !== undefined;
  const log = (line) => errout.write(`[hdc] synology-nas query: ${line}\n`);
  const warn = (line) => errout.write(`[hdc] synology-nas query: WARN ${line}\n`);
  const publicRoot = defaultRepoRoot();
  const loaded = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: "clumps/infrastructure/synology-nas/config.example.json",
  });

  log(`import-hardware${dryRun ? " [dry-run]" : ""}`);
  const result = await importSynologyHardware({
    publicRoot,
    clumpRoot,
    cfg: loaded.data,
    flags,
    dryRun,
    yes,
    log,
    warn,
  });
  return {
    mode: "import-hardware",
    ...result,
  };
}
