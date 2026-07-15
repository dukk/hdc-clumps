import { ensureSynologyDocker } from "./synology-docker-ensure.mjs";
import { collectSynologyHealth, parseSynoupgradeCheck } from "./synology-query-remote.mjs";
import {
  bootstrapSynologySshKeys,
  resolveSynologySshAuth,
  synologyRemoteExec,
  waitForSynologySsh,
} from "./synology-ssh.mjs";

/**
 * @param {object} execOpts
 * @param {boolean} dryRun
 * @param {(line: string) => void} log
 */
export async function runSynologyDsmUpgrade(execOpts, dryRun, log) {
  const { target } = execOpts;
  log(`[${target.id}] DSM: synoupgrade --check …`);
  if (dryRun) {
    return { ok: true, skipped: true, rebooted: false, check: { updateAvailable: false, summary: "dry-run" } };
  }

  const check = synologyRemoteExec(execOpts, "synoupgrade --check 2>&1");
  const parsed = parseSynoupgradeCheck(`${check.stdout}\n${check.stderr}`);
  if (check.status !== 0 && !parsed.updateAvailable) {
    return {
      ok: false,
      skipped: false,
      rebooted: false,
      check: parsed,
      message: `synoupgrade --check failed: ${check.stderr || check.stdout}`.trim(),
    };
  }

  if (!parsed.updateAvailable) {
    log(`[${target.id}] DSM: no update available.`);
    return { ok: true, skipped: true, rebooted: false, check: parsed };
  }

  log(`[${target.id}] DSM: ${parsed.summary}`);
  log(`[${target.id}] DSM: downloading update …`);
  const dl = synologyRemoteExec(
    { ...execOpts, timeoutMs: 900_000 },
    "synoupgrade --download 2>&1",
  );
  if (dl.status !== 0) {
    return {
      ok: false,
      skipped: false,
      rebooted: false,
      check: parsed,
      message: `synoupgrade --download failed: ${dl.stderr || dl.stdout}`.trim(),
    };
  }

  log(`[${target.id}] DSM: starting upgrade (host will reboot) …`);
  const start = synologyRemoteExec(
    { ...execOpts, timeoutMs: 120_000 },
    "synoupgrade --start 2>&1",
  );
  const startOut = `${start.stdout}\n${start.stderr}`;
  const expectsReboot = /reboot|going down/i.test(startOut) || start.status !== 0;

  return {
    ok: true,
    skipped: false,
    rebooted: expectsReboot,
    check: parsed,
    downloadOutput: dl.stdout.slice(0, 500),
    startOutput: startOut.slice(0, 500),
  };
}

/**
 * @param {object} execOpts
 * @param {boolean} dryRun
 * @param {(line: string) => void} log
 */
export async function runSynologyPackageUpgrade(execOpts, dryRun, log) {
  const { target } = execOpts;
  if (dryRun) {
    return { ok: true, skipped: true, message: "dry-run" };
  }

  log(`[${target.id}] packages: synopkg checkupdate …`);
  const check = synologyRemoteExec(
    { ...execOpts, timeoutMs: 300_000 },
    "synopkg checkupdate 2>&1",
  );

  log(`[${target.id}] packages: synopkg upgradeall …`);
  const up = synologyRemoteExec(
    { ...execOpts, timeoutMs: 900_000 },
    "synopkg upgradeall 2>&1",
  );

  const ok = up.status === 0;
  return {
    ok,
    skipped: false,
    checkOutput: `${check.stdout}\n${check.stderr}`.trim().slice(0, 1500),
    upgradeOutput: `${up.stdout}\n${up.stderr}`.trim().slice(0, 1500),
    message: ok ? null : `synopkg upgradeall exit ${up.status}`,
  };
}

/**
 * @param {object} opts
 */
export async function runSynologyMaintainForHost(opts) {
  const {
    deployment,
    target,
    auth,
    spawnSync,
    env,
    identities,
    dryRun,
    skipDsm,
    skipPackages,
    skipSshKeys,
    skipDockerEnsure,
    log,
    warn,
    vault,
    readLineQuestion,
    publicKeyLines,
    rebootWaitMs,
  } = opts;

  /** @type {Record<string, unknown>} */
  const result = {
    system_id: deployment.systemId,
    ok: true,
    steps: {},
    health: null,
  };

  let activeAuth = auth;

  if (deployment.maintain.sshKeysEnabled && !skipSshKeys) {
    const boot = await bootstrapSynologySshKeys({
      target,
      vault,
      spawnSync,
      env,
      identities,
      publicKeyLines,
      readLineQuestion,
      log,
      warn,
      dryRun,
    });
    result.steps = { .../** @type {Record<string, unknown>} */ (result.steps), ssh_bootstrap: boot };
    if (!boot.ok && !dryRun) {
      result.ok = false;
      result.message = "SSH bootstrap failed";
      return result;
    }
    if (boot.auth) activeAuth = boot.auth;
  }

  if (!activeAuth && !dryRun) {
    activeAuth = await resolveSynologySshAuth({
      target,
      vault,
      spawnSync,
      env,
      identities,
      readLineQuestion,
      warn,
      dryRun: false,
    });
  }

  if (!activeAuth && !dryRun) {
    result.ok = false;
    result.message = "SSH authentication unavailable";
    return result;
  }

  const execOpts = {
    target,
    auth: activeAuth ?? { mode: /** @type {const} */ ("pubkey"), password: null },
    spawnSync,
    env,
    identities,
  };

  if (deployment.maintain.dockerEnsure && !skipDockerEnsure) {
    const docker = await ensureSynologyDocker(execOpts, { log, dryRun });
    result.steps = { .../** @type {Record<string, unknown>} */ (result.steps), docker_ensure: docker };
    if (!docker.ok) {
      result.ok = false;
      result.message = docker.message ?? "docker ensure failed";
      return result;
    }
  }

  if (deployment.maintain.dsmUpgrade && !skipDsm) {
    const dsm = await runSynologyDsmUpgrade(execOpts, dryRun, log);
    result.steps = { .../** @type {Record<string, unknown>} */ (result.steps), dsm_upgrade: dsm };
    if (!dsm.ok) {
      result.ok = false;
      result.message = dsm.message ?? "DSM upgrade failed";
      return result;
    }
    if (dsm.rebooted && !dryRun) {
      const back = await waitForSynologySsh({
        target,
        spawnSync,
        env,
        identities,
        timeoutMs: rebootWaitMs,
        log,
      });
      if (!back) {
        result.ok = false;
        result.message = "host did not return via SSH after DSM reboot";
        return result;
      }
    }
  }

  if (deployment.maintain.packageUpgrade && !skipPackages) {
    const pkg = await runSynologyPackageUpgrade(execOpts, dryRun, log);
    result.steps = { .../** @type {Record<string, unknown>} */ (result.steps), package_upgrade: pkg };
    if (!pkg.ok) {
      result.ok = false;
      result.message = pkg.message ?? "package upgrade failed";
    }
  }

  if (!dryRun && activeAuth) {
    const health = collectSynologyHealth({ ...execOpts, auth: activeAuth });
    result.health = health.health;
    if (!health.ok) {
      warn(`[${target.id}] health collect after maintain: ${health.message}`);
    }
  }

  return result;
}
