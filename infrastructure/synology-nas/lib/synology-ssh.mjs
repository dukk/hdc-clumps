import { inventoryIdToVaultSuffix } from "hdc/cli/lib/users-bootstrap-hdc.mjs";
import {
  remoteInstallAuthorizedKeysBash,
  sshBashLc,
  sshReachableWithPubkey,
  sshSpawn,
} from "hdc/cli/lib/ssh-host-access.mjs";

const SYNOLOGY_SSH_PASSWORD_PREFIX = "HDC_SYNOLOGY_SSH_PASSWORD";

/**
 * @param {string} systemId
 */
export function vaultKeyForSynologySshPassword(systemId) {
  return `${SYNOLOGY_SSH_PASSWORD_PREFIX}_${inventoryIdToVaultSuffix(systemId)}`;
}

/**
 * Legacy vault keys from older docs (`NAS_1` / `NAS_2` for instances a/b).
 * @param {string} systemId
 * @returns {string[]}
 */
export function vaultKeysForSynologySshPassword(systemId) {
  const primary = vaultKeyForSynologySshPassword(systemId);
  /** @type {string[]} */
  const keys = [primary];
  const id = String(systemId || "")
    .trim()
    .toLowerCase();
  if (id === "nas-a") keys.push(`${SYNOLOGY_SSH_PASSWORD_PREFIX}_NAS_1`);
  if (id === "nas-b") keys.push(`${SYNOLOGY_SSH_PASSWORD_PREFIX}_NAS_2`);
  return [...new Set(keys)];
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} userEnv
 * @param {string} fallbackUser
 */
export function synologySshUserFromEnv(env, userEnv, fallbackUser = "admin") {
  const fromEnv = typeof env[userEnv] === "string" ? env[userEnv].trim() : "";
  if (fromEnv) return fromEnv;
  const legacy = typeof env.HDC_SYNOLOGY_SSH_USER === "string" ? env.HDC_SYNOLOGY_SSH_USER.trim() : "";
  if (legacy) return legacy;
  return fallbackUser;
}

/**
 * @param {ReturnType<import("./deployments.mjs").resolveSynologyDeployments>[number]} deployment
 * @param {NodeJS.ProcessEnv} env
 */
export function sshTargetFromDeployment(deployment, env) {
  return {
    id: deployment.systemId,
    user: synologySshUserFromEnv(env, deployment.userEnv, deployment.ssh.user),
    host: deployment.ssh.host,
  };
}

/**
 * @param {{ user: string; host: string }} target
 * @param {typeof import("node:child_process").spawnSync} spawnSync
 * @param {NodeJS.ProcessEnv} env
 * @param {string} password
 */
function sshReachableWithPassword(target, spawnSync, env, password) {
  const r = sshSpawn(target, ["true"], {
    spawnSync,
    env,
    mode: "password",
    password,
    timeoutMs: 25_000,
  });
  return r.status === 0;
}

/**
 * @param {object} opts
 */
async function promptAndStoreSshPassword(opts) {
  const { target, vaultKey, vault, spawnSync, env, readLineQuestion, warn } = opts;
  const label = `SSH password for ${target.user}@${target.host} (${target.id})`;
  let emptyAttempts = 0;
  for (;;) {
    const value = await readLineQuestion(`${label}: `, { mask: true });
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) {
      emptyAttempts += 1;
      warn("Empty password; try again or Ctrl+C to abort.");
      // Non-interactive callers often pass async () => "" — fail fast instead of looping forever.
      if (emptyAttempts >= 2 || !process.stdin.isTTY) {
        throw new Error(
          `SSH password required for ${target.user}@${target.host} — set vault ${vaultKey} (hdc secrets set ${vaultKey})`,
        );
      }
      continue;
    }
    if (!sshReachableWithPassword(target, spawnSync, env, trimmed)) {
      warn(`[${target.id}] password verification failed for ${target.user}@${target.host}.`);
      continue;
    }
    await vault.setSecret(vaultKey, trimmed);
    return trimmed;
  }
}

/**
 * @param {object} opts
 * @param {{ id: string; user: string; host: string }} opts.target
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} opts.vault
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ privateKey: string; certificateFile?: string }[]} opts.identities
 * @param {(q: string, o?: { mask?: boolean }) => Promise<string>} opts.readLineQuestion
 * @param {(line: string) => void} opts.warn
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<{ mode: "pubkey" | "password"; password: string | null } | null>}
 */
export async function resolveSynologySshAuth(opts) {
  const { target, vault, spawnSync, env, identities, readLineQuestion, warn, dryRun = false } = opts;

  if (!dryRun && sshReachableWithPubkey(target, spawnSync, env, identities)) {
    return { mode: "pubkey", password: null };
  }

  const vaultKeys = vaultKeysForSynologySshPassword(target.id);
  const vaultKey = vaultKeys[0];
  /** @type {string | null} */
  let password = null;
  const allowPasswordPrompt =
    Boolean(process.stdin.isTTY) &&
    process.env.CURSOR_AGENT !== "1" &&
    process.env.CI !== "true" &&
    process.env.HDC_NONINTERACTIVE !== "1";

  if (!dryRun) {
    /** @type {string[]} */
    const tried = [];
    for (const key of vaultKeys) {
      // Prefer getSecret so local-vault fill-ins work under Vaultwarden backend.
      const stored = String((await vault.getSecret(key, { optional: true })) ?? "").trim();
      if (!stored) continue;
      tried.push(key);
      if (sshReachableWithPassword(target, spawnSync, env, stored)) {
        password = stored;
        if (key !== vaultKey) {
          warn(`[${target.id}] using legacy vault key ${key}; storing as ${vaultKey}.`);
          await vault.setSecret(vaultKey, stored);
        }
        break;
      }
      warn(`[${target.id}] stored vault password for ${key} did not work.`);
    }
    // Do not fall through to an interactive prompt after a rejected vault password —
    // agent/CI shells often report isTTY but nobody is typing (hangs forever).
    if (!password && tried.length > 0) {
      throw new Error(
        `SSH auth failed for ${target.user}@${target.host}: vault password(s) ${tried.join(", ")} rejected (and pubkey unavailable). Fix with: hdc secrets set ${vaultKey} (or install SSH keys).`,
      );
    }
  }

  if (!dryRun && !password) {
    if (!allowPasswordPrompt) {
      throw new Error(
        `SSH auth failed for ${target.user}@${target.host} (pubkey + vault keys ${vaultKeys.join(", ")}); set a working password with hdc secrets set ${vaultKey} or install SSH keys (non-interactive; no password prompt)`,
      );
    }
    password = await promptAndStoreSshPassword({
      target,
      vaultKey,
      vault,
      spawnSync,
      env,
      readLineQuestion,
      warn,
    });
  }

  if (dryRun) return { mode: "pubkey", password: null };
  if (!password && !sshReachableWithPubkey(target, spawnSync, env, identities)) {
    return null;
  }
  if (sshReachableWithPubkey(target, spawnSync, env, identities)) {
    return { mode: "pubkey", password: null };
  }
  return { mode: "password", password };
}

/**
 * @param {string} user
 * @param {string} innerCommand
 * @param {string | null} sudoPassword
 */
export function wrapSynologySudoCommand(user, innerCommand, sudoPassword) {
  if (user === "root") return innerCommand;
  const cmd = innerCommand.replace(/'/g, `'\\''`);
  if (sudoPassword) {
    const pw = sudoPassword.replace(/'/g, `'\\''`);
    return `printf '%s\\n' '${pw}' | sudo -S -p '' bash -lc '${cmd}'`;
  }
  return `sudo bash -lc '${cmd}'`;
}

/**
 * @typedef {object} SynologyExecResult
 * @property {number} status
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @param {object} opts
 * @param {{ id: string; user: string; host: string }} opts.target
 * @param {string} innerCommand
 * @param {object} opts.auth
 * @param {"pubkey" | "password"} opts.auth.mode
 * @param {string | null} opts.auth.password
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ privateKey: string; certificateFile?: string }[]} opts.identities
 * @param {number} [opts.timeoutMs]
 * @returns {SynologyExecResult}
 */
export function synologyRemoteExec(opts, innerCommand) {
  const { target, auth, spawnSync, env, identities, timeoutMs = 120_000 } = opts;
  const script = wrapSynologySudoCommand(target.user, innerCommand, auth.password);
  const r = sshBashLc(target, script, {
    spawnSync,
    env,
    mode: auth.mode,
    identities,
    password: auth.password ?? undefined,
    timeoutMs,
  });
  return {
    status: r.status ?? 1,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
  };
}

/**
 * @param {object} opts
 */
export async function bootstrapSynologySshKeys(opts) {
  const {
    target,
    vault,
    spawnSync,
    env,
    identities,
    publicKeyLines,
    readLineQuestion,
    log,
    warn,
    dryRun = false,
  } = opts;

  if (!publicKeyLines.length) {
    warn(`[${target.id}] no local SSH public keys in ~/.ssh — skip key install.`);
    return { ok: false, pubkeyAuth: false, auth: null };
  }

  if (!dryRun && sshReachableWithPubkey(target, spawnSync, env, identities)) {
    log(`[${target.id}] SSH public-key auth OK for ${target.user}@${target.host}.`);
    return { ok: true, pubkeyAuth: true, auth: { mode: /** @type {const} */ ("pubkey"), password: null } };
  }

  const sshAuth = await resolveSynologySshAuth({
    target,
    vault,
    spawnSync,
    env,
    identities,
    readLineQuestion,
    warn,
    dryRun,
  });
  const password = sshAuth?.mode === "password" ? sshAuth.password : null;

  if (dryRun) {
    log(`[${target.id}] dry-run: would install ${publicKeyLines.length} SSH public key line(s).`);
    return { ok: true, pubkeyAuth: true, auth: sshAuth };
  }

  if (!sshReachableWithPubkey(target, spawnSync, env, identities) && !password) {
    warn(`[${target.id}] cannot reach ${target.user}@${target.host} via SSH.`);
    return { ok: false, pubkeyAuth: false, auth: null };
  }

  const keyLinesB64 = publicKeyLines.map((line) => Buffer.from(line, "utf8").toString("base64"));
  const remote = remoteInstallAuthorizedKeysBash(keyLinesB64);
  log(`[${target.id}] installing ${publicKeyLines.length} SSH public key line(s) …`);

  const install = sshReachableWithPubkey(target, spawnSync, env, identities)
    ? sshBashLc(target, remote, { spawnSync, env, mode: "pubkey", identities, timeoutMs: 60_000 })
    : sshBashLc(target, remote, {
        spawnSync,
        env,
        mode: "password",
        password: password ?? "",
        timeoutMs: 60_000,
      });

  if (install.status !== 0) {
    const err = `${install.stderr ?? ""}${install.stdout ?? ""}`.trim();
    warn(`[${target.id}] authorized_keys install failed: ${err || `status ${install.status ?? "?"}`}`);
    return { ok: false, pubkeyAuth: false, auth: sshAuth };
  }

  if (!sshReachableWithPubkey(target, spawnSync, env, identities)) {
    warn(`[${target.id}] keys installed but public-key auth still fails.`);
    return { ok: false, pubkeyAuth: false, auth: sshAuth };
  }

  log(`[${target.id}] SSH public-key auth ready.`);
  const finalAuth = { mode: /** @type {const} */ ("pubkey"), password: sshAuth?.password ?? null };
  return { ok: true, pubkeyAuth: true, auth: finalAuth };
}

/**
 * Poll until SSH responds or timeout.
 * @param {object} opts
 */
export async function waitForSynologySsh(opts) {
  const { target, spawnSync, env, identities, timeoutMs, log, intervalMs = 15_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  log(`[${target.id}] waiting for SSH after reboot (up to ${Math.round(timeoutMs / 1000)}s) …`);
  while (Date.now() < deadline) {
    if (sshReachableWithPubkey(target, spawnSync, env, identities)) {
      log(`[${target.id}] SSH is back.`);
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
