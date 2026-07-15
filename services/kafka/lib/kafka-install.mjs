import { stderr as errout } from "node:process";

/**
 * @param {string} version
 * @param {string} scalaVersion
 */
export function kafkaTarballName(version, scalaVersion) {
  return `kafka_${scalaVersion}-${version}.tgz`;
}

/**
 * @param {string} version
 * @param {string} scalaVersion
 */
export function kafkaDownloadUrl(version, scalaVersion) {
  const name = kafkaTarballName(version, scalaVersion);
  return `https://archive.apache.org/dist/kafka/${version}/${name}`;
}

/**
 * @param {object} opts
 * @param {string} opts.version
 * @param {string} opts.scalaVersion
 * @param {string[]} opts.logDirs
 */
export function buildKafkaInstallScript(opts) {
  const url = kafkaDownloadUrl(opts.version, opts.scalaVersion);
  const name = kafkaTarballName(opts.version, opts.scalaVersion);
  const logDir = opts.logDirs[0] ?? "/var/lib/kafka/data";
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq openjdk-17-jre-headless curl ca-certificates",
    "if ! id kafka >/dev/null 2>&1; then",
    "  useradd -r -s /usr/sbin/nologin -U -m -d /var/lib/kafka kafka",
    "fi",
    `mkdir -p ${logDir} /etc/kafka /opt/kafka`,
    `chown -R kafka:kafka ${logDir} /var/lib/kafka`,
    `INSTALLED=$(cat /opt/kafka/.hdc-version 2>/dev/null || true)`,
    `TARGET=${opts.version}`,
    'if [ "$INSTALLED" != "$TARGET" ]; then',
    `  curl -fL# -o /tmp/${name} ${url}`,
    `  rm -rf /opt/kafka/kafka_*`,
    `  tar -xzf /tmp/${name} -C /opt/kafka`,
    `  rm -f /tmp/${name}`,
    "  rm -f /opt/kafka/current",
    "  KDIR=$(find /opt/kafka -maxdepth 1 -type d -name 'kafka_*' | head -1)",
    '  ln -sfn "$KDIR" /opt/kafka/current',
    '  echo "$TARGET" > /opt/kafka/.hdc-version',
    "fi",
    "ln -sfn /opt/kafka/current /opt/kafka",
    "chown -R kafka:kafka /opt/kafka /etc/kafka",
    "cat > /etc/systemd/system/kafka.service <<'UNIT'",
    "[Unit]",
    "Description=Apache Kafka (KRaft)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=kafka",
    "Group=kafka",
    "Environment=LOG_DIR=/var/log/kafka",
    "ExecStart=/opt/kafka/bin/kafka-server-start.sh /etc/kafka/server.properties",
    "Restart=on-failure",
    "RestartSec=5",
    "LimitNOFILE=100000",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "mkdir -p /var/log/kafka",
    "chown kafka:kafka /var/log/kafka",
    "systemctl daemon-reload",
    "systemctl enable kafka.service",
    "test -x /opt/kafka/bin/kafka-server-start.sh",
    "test -x /opt/kafka/bin/kafka-storage.sh",
    "",
  ].join("\n");
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {object} opts
 * @param {string} opts.version
 * @param {string} opts.scalaVersion
 * @param {string[]} opts.logDirs
 */
export async function installKafkaOnHost(exec, opts) {
  errout.write(`[hdc] kafka install: ${exec.label} …\n`);
  const script = buildKafkaInstallScript(opts);
  const r = exec.run(script);
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, message: detail };
  }
  errout.write(`[hdc] kafka install: completed on ${exec.label}.\n`);
  return { ok: true, message: "installed" };
}
