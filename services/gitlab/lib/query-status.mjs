import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import {
  composeDir,
  hostPort,
  normalizeExternalUrl,
  resolveSshCloneHint,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./gitlab-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} gitlab
 * @param {Record<string, unknown>} install
 */
export async function queryGitlabInCt(user, pveHost, vmid, gitlab, install) {
  const gl = isObject(gitlab) ? gitlab : {};
  const port = hostPort(gl);
  const dir = composeDir(isObject(install) ? install : {});
  let externalUrl = null;
  try {
    externalUrl = normalizeExternalUrl(gl);
  } catch {
    externalUrl = null;
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
  if (docker.stdout.trim() === "active") {
    const healthCmd = `curl -sf --max-time 10 http://127.0.0.1:${port}/-/health -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      healthOk = true;
    } else {
      healthOk = false;
      healthError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    external_url: externalUrl,
    health_ok: healthOk,
    health_error: healthError,
    host_port: port,
    ssh_host_port: gl.ssh_host_port ?? 2222,
    upstream_url: resolveUpstreamUrl(ctIp, gl),
    web_url: externalUrl ?? resolveWebUrl(gl),
    ssh_clone_hint: resolveSshCloneHint(ctIp, gl),
  };
}
