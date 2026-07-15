/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export function queryPostgresqlActive(exec) {
  const r = exec.run("systemctl is-active postgresql 2>/dev/null || echo inactive", {
    capture: true,
  });
  const active = r.stdout.trim() === "active";
  return { active, status: r.stdout.trim() || "unknown", exit: r.status };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export function queryPgIsready(exec) {
  const r = exec.run("sudo -u postgres pg_isready 2>/dev/null", { capture: true });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export function queryPostgresqlVersion(exec) {
  const r = exec.run('sudo -u postgres psql -tAc "SELECT version();" 2>/dev/null', {
    capture: true,
  });
  return { ok: r.status === 0, version: r.stdout.trim() };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export function queryRecoveryStatus(exec) {
  const r = exec.run('sudo -u postgres psql -tAc "SELECT pg_is_in_recovery();" 2>/dev/null', {
    capture: true,
  });
  const val = r.stdout.trim();
  return {
    ok: r.status === 0,
    in_recovery: val === "t",
    raw: val,
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export function queryReplicationLag(exec) {
  const r = exec.run(
    'sudo -u postgres psql -tAc "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::bigint, -1);" 2>/dev/null',
    { capture: true },
  );
  const lag = Number(r.stdout.trim());
  return {
    ok: r.status === 0,
    lag_seconds: Number.isFinite(lag) ? lag : null,
  };
}
