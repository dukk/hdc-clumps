import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { composeDir, normalizeAioBlock } from "./nextcloud-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} nextcloud
 * @param {Record<string, unknown>} install
 */
export async function queryNextcloudInCt(user, pveHost, vmid, nextcloud, install) {
  const aio = normalizeAioBlock(isObject(nextcloud) ? nextcloud : {});
  const port = aio.interfaceHostPort;
  const dir = composeDir(isObject(install) ? install : {});

  const docker = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active docker 2>/dev/null || echo inactive",
    { capture: true },
  );
  const masterRunning = pctExec(
    user,
    pveHost,
    vmid,
    "docker inspect -f '{{.State.Running}}' nextcloud-aio-mastercontainer 2>/dev/null || echo false",
    { capture: true },
  );
  const composePs = pctExec(
    user,
    pveHost,
    vmid,
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps 2>/dev/null || echo ''`,
    { capture: true },
  );
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  let aioUiOk = null;
  let aioUiError = null;
  if (docker.stdout.trim() === "active" && ctIp && masterRunning.stdout.trim() === "true") {
    const healthCmd = `curl -skf --max-time 8 https://127.0.0.1:${port}/ -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      aioUiOk = true;
    } else {
      aioUiOk = false;
      aioUiError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    mastercontainer_running: masterRunning.stdout.trim() === "true",
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    aio_ui_ok: aioUiOk,
    aio_ui_error: aioUiError,
    interface_host_port: port,
    aio_interface_url: ctIp ? `https://${ctIp}:${port}` : null,
    reverse_proxy_mode: aio.reverseProxyEnabled,
  };
}
