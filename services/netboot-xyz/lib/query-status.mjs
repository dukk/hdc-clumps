import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { nginxHostPort, tftpHostPort, webAppPort } from "./deployments.mjs";
import { composeDir, dhcpHints } from "./netboot-xyz-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} netbootXyz
 * @param {Record<string, unknown>} install
 */
export async function queryNetbootXyzInCt(user, pveHost, vmid, netbootXyz, install) {
  const cfg = isObject(netbootXyz) ? netbootXyz : {};
  const installCfg = isObject(install) ? install : {};
  const webPort = webAppPort(cfg);
  const nginxHost = nginxHostPort(cfg);
  const tftpHost = tftpHostPort(cfg);
  const dir = composeDir(installCfg);

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
  let tftpListening = null;
  let containerRunning = null;

  if (docker.stdout.trim() === "active") {
    const container = pctExec(
      user,
      pveHost,
      vmid,
      "docker ps --filter name=netbootxyz --format '{{.Status}}' 2>/dev/null | head -1",
      { capture: true },
    );
    containerRunning = container.status === 0 && container.stdout.trim().length > 0;

    const healthCmd = `curl -sf --max-time 5 http://127.0.0.1:${webPort}/ -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      httpOk = true;
    } else {
      httpOk = false;
      httpError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }

    const tftpCmd = `ss -ulnp 2>/dev/null | grep -E ':${tftpHost}\\s' >/dev/null && echo ok || echo fail`;
    const t = pctExec(user, pveHost, vmid, tftpCmd, { capture: true });
    if (t.status === 0) {
      tftpListening = t.stdout.trim() === "ok";
    }
  }

  const hints = dhcpHints(ctIp, cfg);

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    container_running: containerRunning,
    http_ok: httpOk,
    http_error: httpError,
    tftp_listening: tftpListening,
    web_app_port: webPort,
    nginx_host_port: nginxHost,
    tftp_host_port: tftpHost,
    web_ui_url: hints.web_ui_url,
    assets_url: hints.assets_url,
    dhcp_hints: hints,
  };
}
