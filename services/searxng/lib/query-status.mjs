import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { hostPort } from "./deployments.mjs";
import { composeDir } from "./searxng-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} searxng
 * @param {Record<string, unknown>} install
 */
export async function querySearxngInCt(user, pveHost, vmid, searxng, install) {
  const port = isObject(searxng) ? hostPort(searxng) : 8080;
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

  let httpOk = null;
  let httpError = null;
  if (docker.stdout.trim() === "active" && ctIp) {
    const healthCmd = `curl -sf --max-time 5 http://127.0.0.1:${port}/ -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      httpOk = true;
    } else {
      httpOk = false;
      httpError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    http_ok: httpOk,
    http_error: httpError,
    port,
    ui_url: ctIp ? `http://${ctIp}:${port}` : null,
  };
}
