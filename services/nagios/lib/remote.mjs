import { spawnSync } from "node:child_process";

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];

/**
 * @param {string} user
 * @param {string} host
 * @param {string} remoteCommand
 * @param {{ capture?: boolean }} opts
 */
export function sshRemote(user, host, remoteCommand, opts = {}) {
  const capture = Boolean(opts.capture);
  const r = spawnSync(
    "ssh",
    [...SSH_OPTS, `${user}@${host}`, remoteCommand],
    capture
      ? { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      : { encoding: "utf8", stdio: "inherit" },
  );
  return { status: r.status ?? 1, stdout: capture ? String(r.stdout ?? "") : "", stderr: capture ? String(r.stderr ?? "") : "" };
}

/**
 * @param {string} user
 * @param {string} host
 * @param {string} localPath
 * @param {string} remotePath
 */
export function scpToRemote(user, host, localPath, remotePath) {
  const r = spawnSync(
    "scp",
    [...SSH_OPTS, localPath, `${user}@${host}:${remotePath}`],
    { encoding: "utf8", stdio: "inherit" },
  );
  return r.status ?? 1;
}
