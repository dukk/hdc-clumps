import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function readCtPrimaryIp(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  if (r.status !== 0) return null;
  const ip = r.stdout.trim().split(/\s+/)[0];
  return ip || null;
}

/**
 * @param {string} configContent
 */
function buildInstallScript(configContent) {
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq wireguard wireguard-tools iproute2",
    "mkdir -p /etc/wireguard",
    "install -m 0700 -d /etc/wireguard",
    "cat > /etc/wireguard/wg0.conf <<'WGCONF'",
    configContent.trimEnd(),
    "WGCONF",
    "chmod 600 /etc/wireguard/wg0.conf",
    "sysctl -w net.ipv4.ip_forward=1 >/dev/null",
    "grep -q '^net.ipv4.ip_forward=1$' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf",
    "systemctl enable wg-quick@wg0",
    "systemctl restart wg-quick@wg0",
    "systemctl is-active wg-quick@wg0",
  ].join("\n");
}

/**
 * @param {string} configContent
 */
function buildMaintainScript(configContent) {
  return [
    "set -euo pipefail",
    "install -m 0700 -d /etc/wireguard",
    "cat > /etc/wireguard/wg0.conf <<'WGCONF'",
    configContent.trimEnd(),
    "WGCONF",
    "chmod 600 /etc/wireguard/wg0.conf",
    "systemctl enable wg-quick@wg0",
    "systemctl restart wg-quick@wg0",
    "systemctl is-active wg-quick@wg0",
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} configContent
 */
export async function installWireguardInCt(user, pveHost, vmid, configContent) {
  errout.write(`[hdc] wireguard install: apt + config in CT ${vmid} …\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, "wireguard install");
  if (!ready) {
    return { ok: false, method: "wireguard", message: `CT ${vmid} not reachable via pct exec` };
  }
  const script = buildInstallScript(configContent);
  const r = pctExec(user, pveHost, vmid, script);
  if (r.status !== 0) {
    return { ok: false, method: "wireguard", message: `install failed (exit ${r.status})` };
  }
  return { ok: true, method: "wireguard", message: "installed and active" };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} configContent
 */
export async function maintainWireguardInCt(user, pveHost, vmid, configContent) {
  errout.write(`[hdc] wireguard maintain: re-applying wg0.conf in CT ${vmid} …\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, "wireguard maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }
  const script = buildMaintainScript(configContent);
  const r = pctExec(user, pveHost, vmid, script);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }
  return { ok: true, message: "wg0.conf applied" };
}
