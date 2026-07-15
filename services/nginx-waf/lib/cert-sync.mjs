import { renderCertSyncScript } from "./nginx-waf-render.mjs";
import { sshTargetFromDeployment } from "./deployments.mjs";

export const CERT_SYNC_SCRIPT_PATH = "/usr/local/bin/hdc-nginx-waf-cert-sync";
export const CERT_SYNC_HOOK_PATH = "/etc/letsencrypt/renewal-hooks/deploy/hdc-nginx-waf-sync";

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
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
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
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
 * @param {ReturnType<typeof import("./deployments.mjs").finalizeDeployment>} opts.primary
 * @param {ReturnType<typeof import("./deployments.mjs").finalizeDeployment>} opts.peer
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.primaryExec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 */
export function installCertSyncOnPrimary(opts) {
  const { primary, peer, primaryExec, log } = opts;
  const peerTarget = sshTargetFromDeployment(peer);
  const script = renderCertSyncScript({
    peerUser: peerTarget.user,
    peerHost: peerTarget.host,
  });
  runChecked(primaryExec, "apt-get install -y rsync openssh-client 2>/dev/null || true", log);
  uploadFile(primaryExec, CERT_SYNC_SCRIPT_PATH, script, log);
  runChecked(
    primaryExec,
    `chmod 755 ${shellQuote(CERT_SYNC_SCRIPT_PATH)} && mkdir -p /etc/letsencrypt/renewal-hooks/deploy`,
    log,
  );
  runChecked(
    primaryExec,
    `ln -sf ${shellQuote(CERT_SYNC_SCRIPT_PATH)} ${shellQuote(CERT_SYNC_HOOK_PATH)}`,
    log,
  );
  log.info(`${primary.systemId}: cert sync hook installed → ${peerTarget.host}`);
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} primaryExec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
export function runCertSync(primaryExec, log) {
  runChecked(primaryExec, `test -x ${shellQuote(CERT_SYNC_SCRIPT_PATH)}`, log);
  runChecked(primaryExec, shellQuote(CERT_SYNC_SCRIPT_PATH), log);
  log.info("cert sync completed");
}
