import { spawnSync } from "node:child_process";
import { devNull } from "node:os";
import { stderr as errout } from "node:process";

const SSH_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  `UserKnownHostsFile=${devNull}`,
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=120",
];

/**
 * Run a bash script on the guest via SSH stdin. Remote stdout and stderr are
 * copied to the local stderr so hdc stdout stays JSON-only.
 * @param {object} opts
 * @param {string} opts.user
 * @param {string} opts.host
 * @param {string} opts.script
 * @param {boolean} [opts.sudo]
 * @param {number} [opts.timeoutMs]
 * @param {(line: string) => void} [opts.log]
 */
export function sshBashStdin(opts) {
  const user = opts.user.trim();
  const host = opts.host.trim();
  const sudo = opts.sudo !== false && user !== "root";
  const remote = sudo ? "sudo -n bash -s" : "bash -s";
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  opts.log?.(`SSH ${user}@${host}: running remote bash script (${sudo ? "sudo" : "direct"}) …`);
  const r = spawnSync("ssh", [...SSH_OPTS, `${user}@${host}`, remote], {
    encoding: "utf8",
    input: opts.script,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = String(r.stdout ?? "");
  const stderr = String(r.stderr ?? "");
  if (stdout) errout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  if (stderr) errout.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  const timedOut = r.error != null && /** @type {NodeJS.ErrnoException} */ (r.error).code === "ETIMEDOUT";
  return {
    status: timedOut ? 124 : (r.status ?? 1),
    timedOut,
    stdout,
  };
}
