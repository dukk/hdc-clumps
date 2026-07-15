import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  cassandraAptSuite,
} from "./deployments.mjs";
import {
  renderCassandraYaml,
  renderJvmOptions,
  renderRackDcProperties,
} from "./cassandra-render.mjs";
import { queryNodetoolStatus, waitForNodeUn } from "./cassandra-query-remote.mjs";

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
 * @param {string} version
 */
function installCassandraScript(version) {
  const suite = cassandraAptSuite(version);
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq curl gnupg openjdk-17-jre-headless",
    "install -d -m 0755 /etc/apt/keyrings",
    "curl -fsSL https://downloads.apache.org/cassandra/KEYS -o /tmp/cassandra-keys.asc",
    "gpg --dearmor -o /etc/apt/keyrings/apache-cassandra.gpg /tmp/cassandra-keys.asc",
    "rm -f /tmp/cassandra-keys.asc",
    `echo "deb [signed-by=/etc/apt/keyrings/apache-cassandra.gpg] https://debian.apache.org/dist/cassandra ${suite} main" > /etc/apt/sources.list.d/cassandra.list`,
    "apt-get update -qq",
    "apt-get install -y -qq cassandra",
    "systemctl stop cassandra 2>/dev/null || true",
    "",
  ].join("\n");
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {string} opts.clusterName
 * @param {string[]} opts.seedIps
 * @param {string} opts.listenIp
 * @param {string} opts.datacenter
 * @param {string} opts.rack
 * @param {string} opts.version
 * @param {number} opts.memoryMb
 * @param {boolean} opts.passwordAuthEnabled
 * @param {boolean} [opts.skipInstall]
 */
export function configureCassandra(opts) {
  const {
    exec,
    log,
    clusterName,
    seedIps,
    listenIp,
    datacenter,
    rack,
    version,
    memoryMb,
    passwordAuthEnabled,
    skipInstall = false,
  } = opts;

  if (!skipInstall) {
    runChecked(exec, installCassandraScript(version), log);
  } else {
    runChecked(exec, "systemctl stop cassandra 2>/dev/null || true", log);
  }

  const yaml = renderCassandraYaml({
    clusterName,
    seedIps,
    listenAddress: listenIp,
    passwordAuthEnabled,
  });
  uploadFile(exec, "/etc/cassandra/cassandra.yaml", yaml, log);

  const rackdc = renderRackDcProperties({ datacenter, rack });
  uploadFile(exec, "/etc/cassandra/cassandra-rackdc.properties", rackdc, log);

  const jvm = renderJvmOptions({ memoryMb });
  uploadFile(exec, "/etc/cassandra/jvm.options", jvm, log);

  runChecked(exec, "chown -R cassandra:cassandra /var/lib/cassandra /etc/cassandra", log);
  runChecked(exec, "systemctl enable cassandra", log);
  runChecked(exec, "systemctl restart cassandra", log);

  return { ok: true, listen_ip: listenIp, cluster_name: clusterName };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {string} opts.listenIp
 * @param {(msg: string) => void} [opts.onProgress]
 */
export async function waitForCassandraReady(opts) {
  return waitForNodeUn(opts.exec, opts.listenIp, 600_000, opts.onProgress);
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {string} opts.password
 * @param {(msg: string) => void} [opts.log]
 */
export function setupSuperuserPassword(opts) {
  const { exec, password, log } = opts;
  const escaped = password.replace(/'/g, "''");
  const check = queryNodetoolStatus(exec);
  if (!check.ok) {
    throw new Error("nodetool status failed before superuser setup");
  }
  const cql = `ALTER ROLE cassandra WITH PASSWORD = '${escaped}' AND SUPERUSER = true AND LOGIN = true;`;
  const r = exec.run(`cqlsh -e ${shellQuote(cql)} 2>/dev/null`, { capture: true });
  if (r.status !== 0) {
    const withAuth = exec.run(
      `cqlsh -u cassandra -p cassandra -e ${shellQuote(cql)} 2>/dev/null`,
      { capture: true },
    );
    if (withAuth.status !== 0) {
      log?.(`superuser setup may already be configured (${withAuth.stderr.trim()})`);
      return { ok: true, skipped: true };
    }
  }
  log?.("cassandra superuser password updated");
  return { ok: true };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 */
export function rollingRestartNode(opts) {
  const { exec, log } = opts;
  runChecked(exec, "nodetool drain 2>/dev/null || true", log);
  runChecked(exec, "systemctl restart cassandra", log);
}
