import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { listenPort } from "./wireguard-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} wireguard
 */
export async function queryWireguardInCt(user, pveHost, vmid, wireguard) {
  const cfg = isObject(wireguard) ? wireguard : {};
  const service = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active wg-quick@wg0 2>/dev/null || echo inactive",
    { capture: true },
  );
  const wgShow = pctExec(user, pveHost, vmid, "wg show 2>/dev/null || true", { capture: true });
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;
  return {
    vmid,
    service_active: service.stdout.trim(),
    wg_show: wgShow.stdout.trim() || null,
    listen_port: listenPort(cfg),
    ct_ip: ctIp,
  };
}
