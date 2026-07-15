/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export function queryKafkaServiceActive(exec) {
  const r = exec.run("systemctl is-active kafka 2>/dev/null || echo inactive", { capture: true });
  return {
    ok: r.status === 0,
    active: r.stdout.trim() === "active",
    raw: r.stdout.trim(),
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {number} listenerPort
 */
export function queryBrokerApiVersions(exec, listenerPort) {
  const r = exec.run(
    `test -x /opt/kafka/bin/kafka-broker-api-versions.sh && /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server 127.0.0.1:${listenerPort} 2>&1 | head -3`,
    { capture: true },
  );
  const ok = r.status === 0 && r.stdout.trim().length > 0;
  return { ok, output: r.stdout.trim().slice(0, 500) };
}
