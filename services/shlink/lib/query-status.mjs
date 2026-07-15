import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import {
  composeDir,
  hostPort,
  parsePublicUrl,
  resolveWebClientUrl,
  resolveWebClientUpstreamUrl,
  webClientConfig,
} from "./shlink-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} shlink
 * @param {Record<string, unknown>} install
 */
export async function queryShlinkInCt(user, pveHost, vmid, shlink, install) {
  const cfg = isObject(shlink) ? shlink : {};
  const port = hostPort(cfg);
  const wc = webClientConfig(cfg);
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
  if (docker.stdout.trim() === "active") {
    const healthCmd = publicUrl
      ? `curl -sf --max-time 5 ${JSON.stringify(`${publicUrl}/rest/health`)} -o /dev/null && echo ok || echo fail`
      : `curl -sf --max-time 5 http://127.0.0.1:${port}/rest/health -o /dev/null && echo ok || echo fail`;
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
    public_url: publicUrl,
    web_client_url: resolveWebClientUrl(cfg, ctIp),
    web_client_upstream_url: resolveWebClientUpstreamUrl(ctIp, cfg),
    web_client_enabled: wc.enabled,
    web_client_host_port: wc.enabled ? wc.host_port : null,
    health_ok: healthOk,
    health_error: healthError,
    host_port: port,
    upstream_url: ctIp ? `http://${ctIp}:${port}` : null,
    url: publicUrl || (ctIp ? `http://${ctIp}:${port}` : null),
  };
}
