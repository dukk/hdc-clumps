/**
 * @param {object} opts
 * @param {string} opts.listenAddresses
 * @param {boolean} opts.replicationEnabled
 */
export function renderHdcPostgresqlConf(opts) {
  const lines = [
    "# Managed by hdc postgresql package",
    `listen_addresses = '${opts.listenAddresses.replace(/'/g, "''")}'`,
  ];
  if (opts.replicationEnabled) {
    lines.push("wal_level = replica");
    lines.push("max_wal_senders = 5");
    lines.push("wal_keep_size = 512MB");
    lines.push("hot_standby = on");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {string[]} listenCidrs
 * @param {string[]} replicationLines host replication user standby_ip/cidr
 */
export function renderHdcPgHbaConf(listenCidrs, replicationLines = []) {
  // Host rules only — local socket auth stays in the distro main pg_hba.conf.
  const lines = ["# Managed by hdc postgresql package"];
  for (const cidr of listenCidrs) {
    lines.push(`host all all ${cidr} scram-sha-256`);
  }
  for (const line of replicationLines) {
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {string} replicationUser
 * @param {string} standbyHostIp
 */
export function replicationHbaLine(replicationUser, standbyHostIp) {
  return `host replication ${replicationUser} ${standbyHostIp}/32 scram-sha-256`;
}
