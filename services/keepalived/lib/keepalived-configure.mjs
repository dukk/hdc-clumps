import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  buildDirectorSysctlCommands,
  renderKeepalivedConf,
  shellQuote,
} from "./keepalived-render.mjs";
import { aptInstallKeepalivedCommand, KEEPALIVED_CONF_PATH } from "./keepalived-install.mjs";

export { createConfigureExec };

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 120)}`);
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
 * @param {ReturnType<typeof import("./deployments.mjs").keepalivedGlobalSettings>} opts.global
 * @param {ReturnType<typeof import("./deployments.mjs").finalizeDirectorDeployment>} opts.director
 * @param {ReturnType<typeof import("./deployments.mjs").parseVrrpInstances>} opts.vrrpInstances
 * @param {ReturnType<typeof import("./deployments.mjs").parseVirtualServers>} opts.virtualServers
 * @param {string} opts.authPass
 * @param {boolean} [opts.skipPackageInstall]
 * @param {boolean} [opts.restartService]
 * @param {boolean} [opts.enableNatForward]
 */
export async function configureKeepalivedDirector(opts) {
  const {
    exec,
    log,
    global,
    director,
    vrrpInstances,
    virtualServers,
    authPass,
    skipPackageInstall = false,
    restartService = true,
    enableNatForward = false,
  } = opts;

  if (!skipPackageInstall) {
    runChecked(exec, aptInstallKeepalivedCommand(), log);
  }

  if (enableNatForward) {
    const sysctlCmd = buildDirectorSysctlCommands(true);
    if (sysctlCmd) runChecked(exec, sysctlCmd, log);
  }

  const conf = renderKeepalivedConf({
    global,
    director,
    vrrpInstances,
    virtualServers,
    authPass,
  });
  uploadFile(exec, KEEPALIVED_CONF_PATH, conf, log);
  runChecked(exec, `chmod 600 ${shellQuote(KEEPALIVED_CONF_PATH)}`, log);

  if (restartService) {
    runChecked(exec, "systemctl enable keepalived", log);
    runChecked(exec, "systemctl restart keepalived", log);
  }

  return { ok: true, config_path: KEEPALIVED_CONF_PATH, state: director.state };
}
