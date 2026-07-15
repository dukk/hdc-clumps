import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { composeDir, hostPort } from "./greenbone-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} greenbone
 * @param {Record<string, unknown>} install
 */
export async function queryGreenboneInCt(user, pveHost, vmid, greenbone, install) {
  const port = hostPort(isObject(greenbone) ? greenbone : {});
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
  const health = pctExec(
    user,
    pveHost,
    vmid,
    `curl -sf --max-time 10 http://127.0.0.1:${port}/ -o /dev/null && echo ok || echo fail`,
    { capture: true },
  );
  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    port,
    http_ok: health.stdout.trim() === "ok",
    ui_url: ctIp ? `http://${ctIp}:${port}` : null,
  };
}
