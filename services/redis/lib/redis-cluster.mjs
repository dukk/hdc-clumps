/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} innerCommand
 */
function execCapture(exec, innerCommand) {
  return exec.run(innerCommand, { capture: true });
}

/**
 * @param {string} password
 */
function shellQuotePassword(password) {
  return `'${password.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {{ host: string; port: number }[]} endpoints
 */
export function formatClusterCreateArgs(endpoints) {
  return endpoints.map((e) => `${e.host}:${e.port}`).join(" ");
}

/**
 * @param {string} clusterInfoStdout
 */
export function parseClusterState(clusterInfoStdout) {
  const line = clusterInfoStdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("cluster_state:"));
  if (!line) return { ok: false, state: "unknown" };
  const state = line.split(":")[1]?.trim() ?? "unknown";
  return { ok: state === "ok", state };
}

/**
 * @param {string} clusterInfoStdout
 */
export function parseClusterSlotsAssigned(clusterInfoStdout) {
  const line = clusterInfoStdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("cluster_slots_assigned:"));
  if (!line) return 0;
  return Number(line.split(":")[1]?.trim()) || 0;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {number} port
 * @param {string} password
 */
export function queryClusterInfo(exec, port, password) {
  const pw = shellQuotePassword(password);
  const r = execCapture(exec, `redis-cli -a ${pw} -p ${port} CLUSTER INFO 2>/dev/null`);
  const state = parseClusterState(r.stdout);
  const slotsAssigned = parseClusterSlotsAssigned(r.stdout);
  return {
    ok: r.status === 0,
    raw: r.stdout.trim(),
    cluster_state: state.state,
    cluster_ok: state.ok,
    cluster_slots_assigned: slotsAssigned,
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {number} port
 * @param {string} password
 */
export function queryRedisPing(exec, port, password) {
  const pw = shellQuotePassword(password);
  const r = execCapture(exec, `redis-cli -a ${pw} -p ${port} ping 2>/dev/null`);
  const pong = r.stdout.trim() === "PONG";
  return { ok: r.status === 0 && pong, pong: r.stdout.trim() };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} host
 * @param {number} port
 * @param {string} password
 */
export function runClusterCheck(exec, host, port, password) {
  const pw = shellQuotePassword(password);
  const r = execCapture(
    exec,
    `redis-cli -a ${pw} -p ${port} --cluster check ${host}:${port} 2>&1`,
  );
  const out = `${r.stdout}${r.stderr}`.trim();
  const ok = r.status === 0 && !/\[ERR\]/.test(out) && /All 16384 slots covered/.test(out);
  return { ok, output: out, status: r.status };
}

/**
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.password
 * @param {{ host: string; port: number }[]} opts.endpoints
 * @param {number} opts.replicas
 */
export function bootstrapRedisCluster(opts) {
  const { exec, host, port, password, endpoints, replicas } = opts;
  const pw = shellQuotePassword(password);
  const nodes = formatClusterCreateArgs(endpoints);
  const cmd =
    `redis-cli -a ${pw} --cluster create ${nodes} --cluster-replicas ${replicas} --cluster-yes 2>&1`;
  const r = execCapture(exec, cmd);
  const out = `${r.stdout}${r.stderr}`.trim();
  const ok =
    r.status === 0 &&
    (/All nodes agree/.test(out) || /All 16384 slots covered/.test(out) || /\[OK\]/.test(out));
  return { ok, output: out, status: r.status };
}

/**
 * Returns true when cluster is already formed.
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {number} port
 * @param {string} password
 */
export function clusterAlreadyInitialized(exec, port, password) {
  const info = queryClusterInfo(exec, port, password);
  return info.cluster_ok && info.cluster_slots_assigned >= 16384;
}
