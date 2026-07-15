import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { composeDir, hostPort, parsePublicUrl } from "./twenty-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** JWT signing failures when ENCRYPTION_KEY drifts from encrypted signing keys in Postgres. */
const JWT_SIGNING_ERROR = "No active signing key available to sign asymmetric token";
const ENCRYPTION_KEY_MISMATCH = "No encryption key matches keyId";

/**
 * @param {string} logs
 */
export function detectJwtSigningIssues(logs) {
  const text = String(logs || "");
  if (text.includes(JWT_SIGNING_ERROR)) {
    return { healthy: false, error: JWT_SIGNING_ERROR };
  }
  if (text.includes(ENCRYPTION_KEY_MISMATCH)) {
    return { healthy: false, error: ENCRYPTION_KEY_MISMATCH };
  }
  return { healthy: true, error: null };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} twenty
 * @param {Record<string, unknown>} install
 */
export async function queryTwentyInCt(user, pveHost, vmid, twenty, install) {
  const cfg = isObject(twenty) ? twenty : {};
  const port = hostPort(cfg);
  const dir = composeDir(isObject(install) ? install : {});
  let publicUrl = null;
  try {
    const parsed = parsePublicUrl(cfg);
    publicUrl = parsed ? parsed.origin.replace(/\/+$/, "") : null;
  } catch {
    publicUrl = null;
  }

  const docker = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active docker 2>/dev/null || echo inactive",
    { capture: true },
  );
  const composePs = pctExec(
    user,
    pveHost,
    vmid,
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  let healthOk = null;
  let healthError = null;
  let jwtSigningHealthy = null;
  let jwtSigningError = null;
  if (docker.stdout.trim() === "active") {
    const healthCmd = `curl -sf --max-time 10 http://127.0.0.1:${port}/healthz -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      healthOk = true;
    } else {
      healthOk = false;
      healthError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }

    const logs = pctExec(
      user,
      pveHost,
      vmid,
      `cd ${JSON.stringify(dir)} && docker compose logs server --tail 150 2>&1 || true`,
      { capture: true },
    );
    const jwt = detectJwtSigningIssues(logs.stdout);
    jwtSigningHealthy = jwt.healthy;
    jwtSigningError = jwt.error;
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    guest_ip: ctIp,
    public_url: publicUrl,
    health_ok: healthOk,
    health_error: healthError,
    jwt_signing_healthy: jwtSigningHealthy,
    jwt_signing_error: jwtSigningError,
    host_port: port,
    upstream_url: ctIp ? `http://${ctIp}:${port}` : null,
    url: publicUrl || (ctIp ? `http://${ctIp}:${port}` : null),
  };
}

/**
 * @param {ReturnType<typeof import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} exec
 * @param {Record<string, unknown>} twenty
 * @param {Record<string, unknown>} install
 * @param {string | null} [guestIp]
 */
export async function queryTwentyOnGuest(exec, twenty, install, guestIp = null) {
  const cfg = isObject(twenty) ? twenty : {};
  const port = hostPort(cfg);
  const dir = composeDir(isObject(install) ? install : {});
  let publicUrl = null;
  try {
    const parsed = parsePublicUrl(cfg);
    publicUrl = parsed ? parsed.origin.replace(/\/+$/, "") : null;
  } catch {
    publicUrl = null;
  }

  const docker = exec.run("systemctl is-active docker 2>/dev/null || echo inactive", {
    capture: true,
  });
  const composePs = exec.run(
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );

  let resolvedIp = guestIp;
  if (!resolvedIp) {
    const ip = exec.run("hostname -I | awk '{print $1}'", { capture: true });
    resolvedIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;
  }

  let healthOk = null;
  let healthError = null;
  let jwtSigningHealthy = null;
  let jwtSigningError = null;
  if (docker.stdout.trim() === "active") {
    const probeUrl = `http://127.0.0.1:${port}/healthz`;
    const h = exec.run(
      `curl -sf --max-time 10 ${JSON.stringify(probeUrl)} -o /dev/null && echo ok || echo fail`,
      { capture: true },
    );
    if (h.status === 0 && h.stdout.trim() === "ok") {
      healthOk = true;
    } else {
      healthOk = false;
      healthError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }

    const logs = exec.run(
      `cd ${JSON.stringify(dir)} && docker compose logs server --tail 150 2>&1 || true`,
      { capture: true },
    );
    const jwt = detectJwtSigningIssues(logs.stdout);
    jwtSigningHealthy = jwt.healthy;
    jwtSigningError = jwt.error;
  }

  return {
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    guest_ip: resolvedIp,
    public_url: publicUrl,
    health_ok: healthOk,
    health_error: healthError,
    jwt_signing_healthy: jwtSigningHealthy,
    jwt_signing_error: jwtSigningError,
    host_port: port,
    upstream_url: resolvedIp ? `http://${resolvedIp}:${port}` : null,
    url: publicUrl || (resolvedIp ? `http://${resolvedIp}:${port}` : null),
  };
}
