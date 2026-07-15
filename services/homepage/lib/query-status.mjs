import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { composeDir, hostPort, normalizePublicUrl } from "./homepage-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} homepage
 * @param {Record<string, unknown>} install
 */
export async function queryHomepageInCt(user, pveHost, vmid, homepage, install) {
  const hp = isObject(homepage) ? homepage : {};
  const port = hostPort(hp);
  const dir = composeDir(isObject(install) ? install : {});
  let publicUrl = null;
  try {
    publicUrl = normalizePublicUrl(hp);
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

  let httpOk = null;
  let httpError = null;
  if (docker.stdout.trim() === "active") {
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
    public_url: publicUrl,
    http_ok: httpOk,
    http_error: httpError,
    host_port: port,
    upstream_url: ctIp ? `http://${ctIp}:${port}` : null,
    web_url: publicUrl,
  };
}
