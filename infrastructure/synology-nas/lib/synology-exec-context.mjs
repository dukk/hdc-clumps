import { spawnSync } from "node:child_process";

import { resolveSynologyDeployments } from "./deployments.mjs";
import {
  resolveSynologySshAuth,
  sshTargetFromDeployment,
} from "./synology-ssh.mjs";
import { createSynologyVaultAccess } from "./vault-deps.mjs";
import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";

/**
 * Resolve deployment, SSH auth, and exec options for Synology remote commands.
 *
 * @param {object} opts
 * @param {Record<string, unknown>} opts.cfg Parsed config.json
 * @param {Record<string, string>} opts.flags CLI flags (--instance, --system-id, …)
 * @param {{ readLineQuestion?: (q: string, o?: { mask?: boolean }) => Promise<string>; warn?: (s: string) => void }} [opts.deps]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof spawnSync} [opts.spawnSync]
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.deploymentIndex] When multiple deployments resolved, pick index (default 0)
 */
export async function createSynologyExecContext(opts) {
  const {
    cfg,
    flags,
    deps = {},
    env = process.env,
    spawnSync: spawn = spawnSync,
    dryRun = false,
    deploymentIndex = 0,
  } = opts;

  const warn = deps.warn ?? (() => {});
  const deployments = resolveSynologyDeployments(cfg, flags);
  const deployment = deployments[deploymentIndex];
  if (!deployment) {
    throw new Error("no Synology deployment matched flags");
  }

  const target = sshTargetFromDeployment(deployment, env);
  const vault = createSynologyVaultAccess();
  await vault.unlock({});

  const { identities } = discoverLocalSshMaterial();

  const auth = dryRun
    ? { mode: /** @type {const} */ ("pubkey"), password: null }
    : await resolveSynologySshAuth({
        target,
        vault,
        spawnSync: spawn,
        env,
        identities,
        readLineQuestion:
          deps.readLineQuestion ??
          (async () => {
            throw new Error(
              `SSH password prompt required for Synology but no readLineQuestion was provided — set vault HDC_SYNOLOGY_SSH_PASSWORD_<SYSTEM_ID>`,
            );
          }),
        warn,
        dryRun: false,
      });

  if (!auth && !dryRun) {
    throw new Error(`SSH authentication unavailable for ${target.id}`);
  }

  const execOpts = {
    target,
    auth: auth ?? { mode: /** @type {const} */ ("pubkey"), password: null },
    spawnSync: spawn,
    env,
    identities,
  };

  /**
   * @param {string} line
   */
  const log = (line) => {
    if (typeof deps.log === "function") deps.log(`[${target.id}] ${line}`);
  };

  return {
    deployment,
    target,
    auth: execOpts.auth,
    execOpts,
    log,
    vault,
  };
}
