import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { aptInstallValkeyCommand } from "./valkey-install.mjs";
import { renderValkeyConf } from "./valkey-render.mjs";

export { createConfigureExec };

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 100)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return r;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} remotePath
 * @param {string} content
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function uploadFile(exec, remotePath, content, log) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  runChecked(exec, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`, log);
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {string} opts.announceIp
 * @param {number} opts.port
 * @param {string} opts.password
 * @param {string} opts.maxmemory
 * @param {string} opts.maxmemoryPolicy
 * @param {boolean} [opts.runInstall]
 */
export function configureValkey(opts) {
  const { exec, log, announceIp, port, password, maxmemory, maxmemoryPolicy, runInstall = true } =
    opts;

  if (runInstall) {
    runChecked(exec, aptInstallValkeyCommand(), log);
  }

  const conf = renderValkeyConf({
    announceIp,
    port,
    maxmemory,
    maxmemoryPolicy,
    password,
  });
  uploadFile(exec, "/etc/valkey/valkey.conf", conf, log);
  runChecked(exec, "chown valkey:valkey /etc/valkey/valkey.conf", log);
  runChecked(exec, "systemctl enable valkey-server", log);
  runChecked(exec, "systemctl restart valkey-server", log);
  runChecked(
    exec,
    `valkey-cli -a ${shellQuote(password)} -p ${port} ping 2>/dev/null | grep -q PONG`,
    log,
  );

  return {
    ok: true,
    message: `Valkey configured (${exec.label})`,
    details: { announce_ip: announceIp, port },
  };
}
