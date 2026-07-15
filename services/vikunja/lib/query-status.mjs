import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { composeDir, hostPort, parsePublicUrl } from "./vikunja-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} vikunja
 * @param {Record<string, unknown>} install
 */
export async function queryVikunjaInCt(user, pveHost, vmid, vikunja, install) {
  const cfg = isObject(vikunja) ? vikunja : {};
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

  let apiOk = null;
  let apiError = null;
  if (docker.stdout.trim() === "active") {
    const infoUrl = publicUrl
      ? `${publicUrl}/api/v1/info`
      : `http://127.0.0.1:${port}/api/v1/info`;
    const h = pctExec(
      user,
      pveHost,
      vmid,
      `curl -sf --max-time 5 ${JSON.stringify(infoUrl)} -o /dev/null && echo ok || echo fail`,
      { capture: true },
    );
    if (h.status === 0 && h.stdout.trim() === "ok") {
      apiOk = true;
    } else {
      apiOk = false;
      apiError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    public_url: publicUrl,
    api_ok: apiOk,
    api_error: apiError,
    host_port: port,
    upstream_url: ctIp ? `http://${ctIp}:${port}` : null,
    url: publicUrl || (ctIp ? `http://${ctIp}:${port}` : null),
  };
}
