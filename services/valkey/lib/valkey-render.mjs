/**
 * Render valkey.conf for cluster mode. Password lines are optional so tests can assert structure without secrets.
 *
 * @param {object} opts
 * @param {string} opts.announceIp
 * @param {number} [opts.port]
 * @param {string} [opts.maxmemory]
 * @param {string} [opts.maxmemoryPolicy]
 * @param {string} [opts.password] when set, emits requirepass and masterauth
 */
export function renderValkeyConf(opts) {
  const port = opts.port ?? 6379;
  const maxmemory = opts.maxmemory ?? "512mb";
  const maxmemoryPolicy = opts.maxmemoryPolicy ?? "allkeys-lru";
  const announceIp = opts.announceIp.trim();
  if (!announceIp) {
    throw new Error("renderValkeyConf: announceIp required");
  }

  const lines = [
    "# Managed by hdc valkey package",
    "bind 0.0.0.0",
    "protected-mode yes",
    `port ${port}`,
    "tcp-backlog 511",
    "timeout 0",
    "tcp-keepalive 300",
    "daemonize no",
    "supervised systemd",
    "loglevel notice",
    "databases 1",
    `maxmemory ${maxmemory}`,
    `maxmemory-policy ${maxmemoryPolicy}`,
    "appendonly yes",
    "appendfsync everysec",
    "cluster-enabled yes",
    "cluster-config-file nodes.conf",
    "cluster-node-timeout 5000",
    `cluster-announce-ip ${announceIp}`,
    `cluster-announce-port ${port}`,
    `cluster-announce-bus-port ${port + 10000}`,
  ];

  if (opts.password && opts.password.trim()) {
    const pw = opts.password.trim();
    lines.push(`requirepass ${pw}`);
    lines.push(`masterauth ${pw}`);
  }

  return `${lines.join("\n")}\n`;
}
