import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import {
  clientConfigSummary,
  composeDir,
  dataDir,
  REQUIRED_PORTS,
  resolveIdServerHost,
} from "./rustdesk-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} rustdesk
 * @param {Record<string, unknown>} install
 */
export async function queryRustdeskInCt(user, pveHost, vmid, rustdesk, install) {
  const cfg = isObject(rustdesk) ? rustdesk : {};
  const installCfg = isObject(install) ? install : {};
  const dir = composeDir(installCfg);
  const pubPath = `${dataDir(installCfg)}/id_ed25519.pub`;

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

  let publicKey = null;
  const keyR = pctExec(
    user,
    pveHost,
    vmid,
    `cat ${JSON.stringify(pubPath)} 2>/dev/null || true`,
    { capture: true },
  );
  if (keyR.status === 0) {
    const k = keyR.stdout.trim();
    publicKey = k || null;
  }

  const idServer = resolveIdServerHost(ctIp, cfg);
  const client = clientConfigSummary(ctIp, publicKey, cfg);

  let hbbsRunning = null;
  let hbbrRunning = null;
  if (docker.stdout.trim() === "active") {
    const hbbs = pctExec(
      user,
      pveHost,
      vmid,
      "docker ps --filter name=hbbs --format '{{.Status}}' 2>/dev/null | head -1",
      { capture: true },
    );
    const hbbr = pctExec(
      user,
      pveHost,
      vmid,
      "docker ps --filter name=hbbr --format '{{.Status}}' 2>/dev/null | head -1",
      { capture: true },
    );
    hbbsRunning = hbbs.status === 0 && hbbs.stdout.trim().length > 0;
    hbbrRunning = hbbr.status === 0 && hbbr.stdout.trim().length > 0;
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    id_server: idServer,
    public_key: publicKey,
    public_key_path: pubPath,
    relay_port: REQUIRED_PORTS.relay_port,
    ports: REQUIRED_PORTS,
    hbbs_running: hbbsRunning,
    hbbr_running: hbbrRunning,
    client,
  };
}
