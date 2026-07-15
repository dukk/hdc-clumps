import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { resolvePveSshForHost, waitForCt } from "../../ollama/lib/ollama-install.mjs";

export { resolvePveSshForHost, waitForCt };

/** pct exec non-login shells often have an empty PATH; Pi-hole installs to /usr/local/bin. */
const SHELL_PATH_EXPORT =
  'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"';

/**
 * @param {Record<string, unknown>} pihole
 */
function upstreamDnsList(pihole) {
  const raw = Array.isArray(pihole.upstream_dns) ? pihole.upstream_dns : [];
  const list = raw.map((x) => String(x).trim()).filter(Boolean);
  return list.length ? list : ["1.1.1.1", "1.0.0.1"];
}

/**
 * @param {Record<string, unknown>} pihole
 * @param {string} webPassword
 */
function buildInstallScript(pihole, webPassword) {
  const upstream = upstreamDnsList(pihole);
  const iface =
    typeof pihole.interface === "string" && pihole.interface.trim() ? pihole.interface.trim() : "eth0";
  const dns1 = upstream[0] ?? "1.1.1.1";
  const dns2 = upstream[1] ?? "";
  const escapedPw = webPassword.replace(/'/g, `'\\''`);

  return [
    "set -euo pipefail",
    SHELL_PATH_EXPORT,
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq curl ca-certificates",
    "mkdir -p /etc/pihole",
    `cat > /etc/pihole/setupVars.conf <<'SETUPVARS'`,
    `PIHOLE_INTERFACE=${iface}`,
    "IPV4_ADDRESS=0.0.0.0/0",
    "IPV6_ADDRESS=",
    `PIHOLE_DNS_1=${dns1}`,
    dns2 ? `PIHOLE_DNS_2=${dns2}` : "PIHOLE_DNS_2=",
    "QUERY_LOGGING=true",
    "INSTALL_WEB_SERVER=true",
    "INSTALL_WEB_INTERFACE=true",
    "LIGHTTPD_ENABLED=true",
    "BLOCKING_ENABLED=true",
    "PIHOLE_SKIP_OS_CHECK=true",
    "SETUPVARS",
    `echo "WEBPASSWORD=${escapedPw}" >> /etc/pihole/setupVars.conf`,
    "curl -fsSL https://install.pi-hole.net | bash /dev/stdin --unattended",
    "command -v pihole >/dev/null",
    "pihole -v >/dev/null",
    "systemctl is-active --quiet pihole-FTL",
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} pihole
 * @param {string} webPassword
 */
export async function installPiHoleInCt(user, pveHost, vmid, pihole, webPassword) {
  errout.write(`[hdc] pi-hole install: unattended install in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "pi-hole install");
  if (!ready) {
    return { ok: false, method: "unattended", message: `CT ${vmid} not reachable via pct exec` };
  }

  const inner = buildInstallScript(pihole, webPassword);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "unattended",
      message: `install failed (exit ${r.status})`,
    };
  }
  errout.write(`[hdc] pi-hole install: completed on CT ${vmid}.\n`);
  return { ok: true, method: "unattended", message: "installed" };
}

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
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function piholeInstalled(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "command -v pihole >/dev/null && echo yes", { capture: true });
  return r.status === 0 && r.stdout.trim() === "yes";
}
