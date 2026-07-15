import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { composeDir, normalizeImage } from "./globalping-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} globalping
 * @param {Record<string, unknown>} install
 */
export async function queryGlobalpingInCt(user, pveHost, vmid, globalping, install) {
  const cfg = isObject(globalping) ? globalping : {};
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
  const probeState = pctExec(
    user,
    pveHost,
    vmid,
    "docker inspect -f '{{.State.Status}}' globalping-probe 2>/dev/null || echo missing",
    { capture: true },
  );
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  const probeStatus = probeState.stdout.trim();
  const containerRunning = probeStatus === "running";

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    image: normalizeImage(cfg),
    probe_container: "globalping-probe",
    probe_status: probeStatus,
    container_running: containerRunning,
  };
}
