/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} splunkHome
 */
export function querySplunkStatus(exec, splunkHome = "/opt/splunk") {
  const r = exec.run(`${splunkHome}/bin/splunk status 2>&1`, { capture: true });
  const running = r.stdout.includes("splunkd is running");
  return { ok: r.status === 0, running, output: `${r.stdout}${r.stderr}`.trim() };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} splunkHome
 */
export function querySplunkVersion(exec, splunkHome = "/opt/splunk") {
  const r = exec.run(`${splunkHome}/bin/splunk version 2>&1`, { capture: true });
  return { ok: r.status === 0, version: r.stdout.trim() };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {number} port
 */
export function queryTcpPort(exec, port) {
  const r = exec.run(
    `timeout 3 bash -c 'echo >/dev/tcp/127.0.0.1/${port}' 2>/dev/null && echo open || echo closed`,
    { capture: true },
  );
  return { ok: r.stdout.trim() === "open", state: r.stdout.trim() };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} varMount
 */
export function querySplunkVarDisk(exec, varMount = "/opt/splunk/var") {
  const r = exec.run(`df -hP ${varMount} 2>/dev/null | tail -1`, { capture: true });
  return { ok: r.status === 0, df: r.stdout.trim() };
}
