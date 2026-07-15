import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { composeDir, hostPort, normalizeDomain } from "./vaultwarden-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} vaultwarden
 * @param {Record<string, unknown>} install
 */
export async function queryVaultwardenInCt(user, pveHost, vmid, vaultwarden, install) {
  const vw = isObject(vaultwarden) ? vaultwarden : {};
  const port = hostPort(vw);
  const dir = composeDir(isObject(install) ? install : {});
  let domain = null;
  try {
    domain = normalizeDomain(vw);
  } catch {
    domain = null;
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

  let aliveOk = null;
  let aliveError = null;
  if (docker.stdout.trim() === "active") {
    const healthCmd = domain
      ? `curl -sf --max-time 5 ${JSON.stringify(`${domain}/alive`)} -o /dev/null && echo ok || echo fail`
      : `curl -sf --max-time 5 http://127.0.0.1:${port}/alive -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      aliveOk = true;
    } else {
      aliveOk = false;
      aliveError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    domain,
    alive_ok: aliveOk,
    alive_error: aliveError,
    host_port: port,
    upstream_url: ctIp ? `http://${ctIp}:${port}` : null,
    web_url: domain,
    admin_url: domain ? `${domain}/admin` : null,
  };
}
