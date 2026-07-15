import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  buildControllerQuorumVoters,
  clusterNodesFromDeployments,
  renderServerProperties,
} from "./kafka-render.mjs";
import { installKafkaOnHost } from "./kafka-install.mjs";

export { createConfigureExec };

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} cmd
 */
function runChecked(exec, cmd) {
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
 */
function uploadFile(exec, remotePath, content) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  runChecked(exec, `mkdir -p /etc/kafka && echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`);
  runChecked(exec, `chown kafka:kafka ${shellQuote(remotePath)}`);
}

/**
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {ReturnType<import("./deployments.mjs").resolveAllKafkaDeployments>} opts.allDeployments
 * @param {ReturnType<import("./deployments.mjs").finalizeDeployment>} opts.deployment
 * @param {ReturnType<import("./deployments.mjs").kafkaGlobalSettings>} opts.global
 * @param {boolean} [opts.restart]
 */
export async function configureKafkaNode(opts) {
  const { exec, allDeployments, deployment, global, restart = true } = opts;
  const install = await installKafkaOnHost(exec, {
    version: global.version,
    scalaVersion: global.scalaVersion,
    logDirs: global.logDirs,
  });
  if (!install.ok) {
    return { ok: false, install, configure: null };
  }

  const nodes = clusterNodesFromDeployments(allDeployments);
  const quorumVoters = buildControllerQuorumVoters(nodes, global.controllerPort);
  const props = renderServerProperties({
    nodeId: deployment.nodeId,
    clusterId: global.clusterId,
    advertisedHost: deployment.sshHost,
    listenerPort: global.listenerPort,
    controllerPort: global.controllerPort,
    quorumVoters,
    logDirs: global.logDirs,
  });

  uploadFile(exec, "/etc/kafka/server.properties", props);

  const logDir = global.logDirs[0] ?? "/var/lib/kafka/data";
  const metaPath = `${logDir}/meta.properties`;
  const checkMeta = exec.run(`test -f ${shellQuote(metaPath)}`, { capture: true });
  let formatted = false;
  if (checkMeta.status !== 0) {
    runChecked(
      exec,
      [
        `chown -R kafka:kafka ${shellQuote(logDir)}`,
        `/opt/kafka/bin/kafka-storage.sh format -t ${shellQuote(global.clusterId)} -c /etc/kafka/server.properties`,
      ].join(" && "),
    );
    formatted = true;
  }

  if (restart) {
    runChecked(exec, "systemctl restart kafka.service");
    runChecked(exec, "systemctl is-active --quiet kafka.service");
  } else {
    runChecked(exec, "systemctl enable kafka.service");
  }

  return {
    ok: true,
    install,
    configure: { formatted, quorum_voters: quorumVoters },
  };
}
