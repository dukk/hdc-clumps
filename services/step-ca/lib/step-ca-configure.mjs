import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  buildStepCaInitCommand,
  chownStepCaTreeCommand,
  patchCaJsonListenAddress,
  renderSystemdUnit,
  rewriteCaJsonPaths,
  shellQuote,
  stepCaHealthProbeCommand,
} from "./step-ca-render.mjs";
import {
  aptInstallStepCaCommand,
  caConfigPath,
  caPasswordPath,
} from "./step-ca-install.mjs";

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
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} remotePath
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function remoteFileExists(exec, remotePath) {
  const r = exec.run(`test -s ${shellQuote(remotePath)}`, { capture: true });
  return r.status === 0;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} remotePath
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function readRemoteFile(exec, remotePath, log) {
  const r = runChecked(exec, `cat ${shellQuote(remotePath)}`, log);
  return r.stdout;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").stepCaGlobalSettings>} opts.global
 * @param {string} opts.caPassword
 * @param {boolean} [opts.skipPackageInstall]
 * @param {boolean} [opts.restartService]
 */
export async function configureStepCaServer(opts) {
  const { exec, log, global, caPassword, skipPackageInstall = false, restartService = true } = opts;
  const stepPath = global.stepPath.replace(/\/$/, "");
  const configPath = caConfigPath(stepPath);
  const passwordPath = caPasswordPath(stepPath);
  const initPassPath = "/tmp/hdc-step-ca-init-pass.txt";

  if (!skipPackageInstall) {
    runChecked(exec, aptInstallStepCaCommand(), log);
  }

  runChecked(exec, `mkdir -p ${shellQuote(stepPath)}/config ${shellQuote(stepPath)}/certs ${shellQuote(stepPath)}/secrets`, log);

  const initialized = remoteFileExists(exec, configPath, log);
  const rootCertPath = `${stepPath}/certs/root_ca.crt`;
  const hasExistingCaCerts =
    exec.run(`test -f ${shellQuote(rootCertPath)}`, { capture: true }).status === 0;

  if (!initialized && hasExistingCaCerts) {
    throw new Error(
      `${configPath} is missing or empty but ${rootCertPath} exists on ${exec.label}; restore ca.json from backup before maintain (re-init would rotate the CA)`,
    );
  }

  if (!initialized && global) {
    uploadFile(exec, initPassPath, `${caPassword}\n`, log);
    runChecked(exec, `chmod 600 ${shellQuote(initPassPath)}`, log);
    runChecked(exec, buildStepCaInitCommand(global, initPassPath), log);
    runChecked(exec, `rm -f ${shellQuote(initPassPath)}`, log);

    if (remoteFileExists(exec, configPath, log)) {
      let caJson = readRemoteFile(exec, configPath, log);
      caJson = rewriteCaJsonPaths(caJson, stepPath);
      caJson = patchCaJsonListenAddress(caJson, global.listenAddress);
      uploadFile(exec, configPath, caJson, log);
    }
  } else if (initialized) {
    let caJson = readRemoteFile(exec, configPath, log);
    if (!caJson.trim()) {
      throw new Error(
        `${configPath} is empty on ${exec.label}; restore ca.json from backup before maintain (re-init would rotate the CA)`,
      );
    }
    caJson = rewriteCaJsonPaths(caJson, stepPath);
    caJson = patchCaJsonListenAddress(caJson, global.listenAddress);
    uploadFile(exec, configPath, caJson, log);
  }

  uploadFile(exec, passwordPath, `${caPassword}\n`, log);
  uploadFile(exec, "/etc/systemd/system/step-ca.service", renderSystemdUnit(stepPath), log);
  runChecked(exec, chownStepCaTreeCommand(stepPath), log);
  runChecked(exec, "systemctl daemon-reload", log);
  runChecked(exec, "systemctl enable step-ca", log);

  if (restartService) {
    runChecked(exec, "systemctl restart step-ca", log);
  } else {
    runChecked(exec, "systemctl start step-ca", log);
  }

  const health = runChecked(exec, stepCaHealthProbeCommand(global.listenAddress), log);
  const active = exec.run("systemctl is-active step-ca", { capture: true });

  return {
    initialized: initialized || remoteFileExists(exec, configPath, log),
    config_path: configPath,
    service_active: active.stdout.trim() === "active",
    health: health.stdout.trim().slice(0, 200),
  };
}
