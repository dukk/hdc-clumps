import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { renderInputsConf, renderServerConf } from "./splunk-render.mjs";
import { buildSplunkInstallScript } from "./splunk-install.mjs";
import { buildDataDiskMountScript } from "./proxmox-data-disk.mjs";

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
 * @param {ReturnType<typeof import("./deployments.mjs").splunkGlobalSettings>} opts.global
 * @param {ReturnType<typeof import("./deployments.mjs").splunkSettingsForDeployment>} opts.local
 * @param {string} opts.adminPassword
 * @param {boolean} opts.skipPackageUpgrade
 * @param {number} opts.dataDiskGb
 */
export async function configureSplunkStandalone(opts) {
  const { exec, log, global, local, adminPassword, skipPackageUpgrade, dataDiskGb } = opts;
  const home = global.splunkHome;
  const etcLocal = `${home}/etc/system/local`;

  if (dataDiskGb > 0) {
    const mountScript = buildDataDiskMountScript({ mountPath: global.varMount });
    runChecked(exec, mountScript, log);
  }

  if (!skipPackageUpgrade) {
    runChecked(
      exec,
      buildSplunkInstallScript({
        version: global.version,
        build: global.build,
        splunkHome: global.splunkHome,
        downloadDir: global.varMount,
      }),
      log,
    );
  }

  runChecked(exec, `mkdir -p ${shellQuote(etcLocal)}`, log);
  uploadFile(exec, `${etcLocal}/server.conf`, renderServerConf({
    serverName: local.serverName,
    mgmtPort: global.mgmtPort,
  }), log);
  uploadFile(exec, `${etcLocal}/inputs.conf`, renderInputsConf(local.inputs), log);
  runChecked(exec, `chown -R splunk:splunk ${shellQuote(home)}`, log);

  runChecked(
    exec,
    [
      `if ! ${home}/bin/splunk status >/dev/null 2>&1; then`,
      `  ${home}/bin/splunk enable boot-start -user splunk --accept-license --answer-yes --no-prompt`,
      `  ${home}/bin/splunk start --accept-license --answer-yes --no-prompt`,
      "else",
      `  ${home}/bin/splunk restart --accept-license --answer-yes --no-prompt`,
      "fi",
    ].join("\n"),
    log,
  );

  const passB64 = Buffer.from(adminPassword, "utf8").toString("base64");
  runChecked(
    exec,
    [
      "set -euo pipefail",
      `PASS=$(echo ${shellQuote(passB64)} | base64 -d)`,
      `if ${home}/bin/splunk list user admin -auth "admin:changeme" >/dev/null 2>&1; then`,
      `  ${home}/bin/splunk edit user admin -password "$PASS" -auth admin:changeme --accept-license --answer-yes --no-prompt`,
      "fi",
    ].join("\n"),
    log,
  );

  runChecked(exec, `${home}/bin/splunk restart --accept-license --answer-yes --no-prompt`, log);

  const status = exec.run(`${home}/bin/splunk status`, { capture: true });
  return {
    ok: status.status === 0,
    message: status.stdout.trim() || "configured",
    server_name: local.serverName,
  };
}
