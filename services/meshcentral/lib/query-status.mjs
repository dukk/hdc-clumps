import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import {
  composeDir,
  MESHCENTRAL_HTTP_PORT,
  resolveHostname,
  resolvePublicUrl,
  serviceSummary,
} from "./meshcentral-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} meshcentral
 * @param {Record<string, unknown>} install
 */
export async function queryMeshcentralInCt(user, pveHost, vmid, meshcentral, install) {
  const cfg = isObject(meshcentral) ? meshcentral : {};
  const installCfg = isObject(install) ? install : {};
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

  let meshcentralRunning = null;
  let mongodbRunning = null;
  let httpOk = null;
  if (docker.stdout.trim() === "active") {
    const mc = pctExec(
      user,
      pveHost,
      vmid,
      "docker ps --filter name=meshcentral --format '{{.Status}}' 2>/dev/null | head -1",
      { capture: true },
    );
    const mongo = pctExec(
      user,
      pveHost,
      vmid,
      "docker ps --filter name=mongodb --format '{{.Status}}' 2>/dev/null | head -1",
      { capture: true },
    );
    meshcentralRunning = mc.status === 0 && mc.stdout.trim().length > 0;
    mongodbRunning = mongo.status === 0 && mongo.stdout.trim().length > 0;
    const probe = pctExec(
      user,
      pveHost,
      vmid,
      `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${MESHCENTRAL_HTTP_PORT}/ 2>/dev/null || echo fail`,
      { capture: true },
    );
    httpOk = probe.status === 0 && /^[23]/.test(probe.stdout.trim());
  }

  const summary = serviceSummary(ctIp, cfg);
  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    hostname: summary.hostname,
    public_url: summary.public_url,
    http_port: MESHCENTRAL_HTTP_PORT,
    meshcentral_running: meshcentralRunning,
    mongodb_running: mongodbRunning,
    http_ok: httpOk,
    service: summary,
  };
}
