import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { apiPort, dashboardPort } from "./deployments.mjs";
import { composeDir, resolveApiUrl, resolveDashboardUrl } from "./hermes-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<typeof import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} exec
 * @param {Record<string, unknown>} hermes
 * @param {Record<string, unknown>} install
 * @param {string | null} [guestIp]
 */
export async function queryHermesOnGuest(exec, hermes, install, guestIp = null) {
  const hermesCfg = isObject(hermes) ? hermes : {};
  const dashPort = dashboardPort(hermesCfg);
  const api = apiPort(hermesCfg);
  const dir = composeDir(isObject(install) ? install : {});

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

  let dashboardHttpOk = null;
  let dashboardHttpError = null;
  if (docker.stdout.trim() === "active") {
    const healthCmd = `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${dashPort}/ || true); echo "$code"`;
    const h = exec.run(healthCmd, { capture: true });
    const code = h.status === 0 ? h.stdout.trim() : "";
    if (code === "200" || code === "302" || code === "401") {
      dashboardHttpOk = true;
    } else {
      dashboardHttpOk = false;
      dashboardHttpError = h.stderr.trim() || code || `exit ${h.status}`;
    }
  }

  return {
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    guest_ip: resolvedIp,
    dashboard_http_ok: dashboardHttpOk,
    dashboard_http_error: dashboardHttpError,
    dashboard_port: dashPort,
    api_port: api,
    dashboard_url: resolveDashboardUrl(hermesCfg, resolvedIp),
    api_url: resolveApiUrl(hermesCfg, resolvedIp),
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} hermes
 * @param {Record<string, unknown>} install
 */
export async function queryHermesInCt(user, pveHost, vmid, hermes, install) {
  const hermesCfg = isObject(hermes) ? hermes : {};
  const dashPort = dashboardPort(hermesCfg);
  const api = apiPort(hermesCfg);
  const dir = composeDir(isObject(install) ? install : {});

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

  let dashboardHttpOk = null;
  let dashboardHttpError = null;
  if (docker.stdout.trim() === "active" && ctIp) {
    const healthCmd = `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${dashPort}/ || true); echo "$code"`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    const code = h.status === 0 ? h.stdout.trim() : "";
    if (code === "200" || code === "302" || code === "401") {
      dashboardHttpOk = true;
    } else {
      dashboardHttpOk = false;
      dashboardHttpError = h.stderr.trim() || code || `exit ${h.status}`;
    }
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    dashboard_http_ok: dashboardHttpOk,
    dashboard_http_error: dashboardHttpError,
    dashboard_port: dashPort,
    api_port: api,
    dashboard_url: resolveDashboardUrl(hermesCfg, ctIp),
    api_url: resolveApiUrl(hermesCfg, ctIp),
  };
}
