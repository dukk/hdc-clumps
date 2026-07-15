import { stderr as errout } from "node:process";

import { pctExec, sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { resolveGuestSshTargetWithFallback, wrapRemoteShellForSshUser } from "hdc/package/guest-ssh-exec.mjs";
import { resolvePveSshForHost, waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolveReleaseTarget } from "./uptime-kuma-release.mjs";

export { resolvePveSshForHost, waitForCt };

/** Ubuntu 22.04 LXC templates often lack universe; browser package is optional for HTTP-only monitors. */
export const CHROMIUM_APT_SHELL = [
  "(",
  "  grep -qs ' universe' /etc/apt/sources.list || sed -i 's/ main$/ main universe/' /etc/apt/sources.list",
  "  apt-get update -qq",
  "  for CHROMIUM_PKG in chromium-browser chromium; do",
  '    if apt-cache show "${CHROMIUM_PKG}" >/dev/null 2>&1; then',
  '      apt-get install -y -qq "${CHROMIUM_PKG}" && break',
  "    fi",
  "  done",
  ") || true",
];

export const CHROMIUM_SYMLINK_SHELL = [
  'CHROMIUM_BIN=""',
  "for c in /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium; do",
  '  if [ -x "$c" ]; then CHROMIUM_BIN="$c"; break; fi',
  "done",
  'if [ -n "$CHROMIUM_BIN" ]; then ln -sf "$CHROMIUM_BIN" /opt/uptime-kuma/chromium; fi',
];

/**
 * @param {Record<string, unknown>} uptimeKuma
 */
function nodeMajor(uptimeKuma) {
  const raw =
    typeof uptimeKuma.node_version === "string" && uptimeKuma.node_version.trim()
      ? uptimeKuma.node_version.trim()
      : "22";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 22;
}

/**
 * @param {string} tag
 * @param {string} tarballUrl
 * @param {number} nodeVer
 */
export function buildInstallScript(tag, tarballUrl, nodeVer) {
  const escapedUrl = tarballUrl.replace(/'/g, `'\\''`);
  const escapedTag = tag.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq curl ca-certificates",
    ...CHROMIUM_APT_SHELL,
    `curl -fsSL https://deb.nodesource.com/setup_${nodeVer}.x | bash -`,
    "apt-get install -y -qq nodejs",
    "command -v node >/dev/null && command -v npm >/dev/null",
    "mkdir -p /opt/uptime-kuma",
    "rm -rf /opt/uptime-kuma/* /opt/uptime-kuma/.[!.]* 2>/dev/null || true",
    `curl -fL# -o /tmp/uptime-kuma-${escapedTag}.tar.gz '${escapedUrl}'`,
    `tar -xzf /tmp/uptime-kuma-${escapedTag}.tar.gz -C /opt/uptime-kuma --strip-components=1`,
    `rm -f /tmp/uptime-kuma-${escapedTag}.tar.gz`,
    "cd /opt/uptime-kuma",
    "npm ci --omit=dev",
    "npm run download-dist",
    ...CHROMIUM_SYMLINK_SHELL,
    `echo '${escapedTag}' > /opt/uptime-kuma/.hdc-release-tag`,
    "cat > /etc/systemd/system/uptime-kuma.service <<'UNIT'",
    "[Unit]",
    "Description=uptime-kuma",
    "",
    "[Service]",
    "Type=simple",
    "Restart=always",
    "User=root",
    "WorkingDirectory=/opt/uptime-kuma",
    "ExecStart=/usr/bin/npm start",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "systemctl daemon-reload",
    "systemctl enable -q --now uptime-kuma",
    "systemctl is-active --quiet uptime-kuma",
  ].join("\n");
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
export function readInstalledReleaseTag(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "cat /opt/uptime-kuma/.hdc-release-tag 2>/dev/null || true", {
    capture: true,
  });
  if (r.status !== 0) return null;
  const tag = r.stdout.trim();
  return tag || null;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function uptimeKumaInstalled(user, pveHost, vmid) {
  const r = pctExec(
    user,
    pveHost,
    vmid,
    "test -f /opt/uptime-kuma/package.json && systemctl is-active --quiet uptime-kuma",
    { capture: true },
  );
  return r.status === 0;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} uptimeKuma
 */
export async function installUptimeKumaInCt(user, pveHost, vmid, uptimeKuma) {
  errout.write(`[hdc] uptime-kuma install: release + npm install in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "uptime-kuma install");
  if (!ready) {
    return { ok: false, method: "tarball", message: `CT ${vmid} not reachable via pct exec` };
  }

  const releaseSpec =
    typeof uptimeKuma.release === "string" && uptimeKuma.release.trim()
      ? uptimeKuma.release.trim()
      : "latest";
  let tag;
  let tarballUrl;
  try {
    const resolved = await resolveReleaseTarget(releaseSpec);
    tag = resolved.tag;
    tarballUrl = resolved.tarballUrl;
    errout.write(
      `[hdc] uptime-kuma install: using release ${JSON.stringify(tag)} (${resolved.source}) …\n`,
    );
  } catch (e) {
    return {
      ok: false,
      method: "tarball",
      message: String(/** @type {Error} */ (e).message || e),
    };
  }

  const inner = buildInstallScript(tag, tarballUrl, nodeMajor(uptimeKuma));
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "tarball",
      message: `install failed (exit ${r.status})`,
      release: tag,
    };
  }
  errout.write(`[hdc] uptime-kuma install: completed on CT ${vmid} (release ${tag}).\n`);
  return { ok: true, method: "tarball", message: "installed", release: tag };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function verifyUptimeKumaInCt(user, pveHost, vmid) {
  errout.write(`[hdc] uptime-kuma configure: verifying systemd on CT ${vmid} …\n`);
  const r = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active --quiet uptime-kuma && test -f /opt/uptime-kuma/package.json",
    { capture: true },
  );
  if (r.status !== 0) {
    return { ok: false, message: "uptime-kuma service not active or package missing" };
  }
  return { ok: true, message: "service active" };
}

export function sshRunAsUser(host, user, inner, opts) {
  return sshRemote(user, host, wrapRemoteShellForSshUser(inner, user), opts);
}

/**
 * @param {string} host
 * @param {string} user
 */
export function readInstalledReleaseTagOverSsh(host, user) {
  const r = sshRunAsUser(host, user, "cat /opt/uptime-kuma/.hdc-release-tag 2>/dev/null || true", {
    capture: true,
  });
  if (r.status !== 0) return null;
  const tag = r.stdout.trim();
  return tag || null;
}

/**
 * @param {string} host
 * @param {string} user
 */
export function uptimeKumaInstalledOverSsh(host, user) {
  const r = sshRunAsUser(
    host,
    user,
    "test -f /opt/uptime-kuma/package.json && systemctl is-active --quiet uptime-kuma",
    { capture: true },
  );
  return r.status === 0;
}

/**
 * @param {string} host
 * @param {string} user
 * @param {Record<string, unknown>} uptimeKuma
 */
export async function installUptimeKumaOverSsh(host, user, uptimeKuma) {
  errout.write(`[hdc] uptime-kuma install: release + npm install on ${user}@${host} …\n`);

  const releaseSpec =
    typeof uptimeKuma.release === "string" && uptimeKuma.release.trim()
      ? uptimeKuma.release.trim()
      : "latest";
  let tag;
  let tarballUrl;
  try {
    const resolved = await resolveReleaseTarget(releaseSpec);
    tag = resolved.tag;
    tarballUrl = resolved.tarballUrl;
    errout.write(
      `[hdc] uptime-kuma install: using release ${JSON.stringify(tag)} (${resolved.source}) …\n`,
    );
  } catch (e) {
    return {
      ok: false,
      method: "tarball",
      message: String(/** @type {Error} */ (e).message || e),
    };
  }

  const inner = buildInstallScript(tag, tarballUrl, nodeMajor(uptimeKuma));
  const r = sshRunAsUser(host, user, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "tarball",
      message: `install failed (exit ${r.status})`,
      release: tag,
    };
  }
  errout.write(`[hdc] uptime-kuma install: completed on ${host} (release ${tag}).\n`);
  return { ok: true, method: "tarball", message: "installed", release: tag };
}

/**
 * @param {string} host
 * @param {string} user
 */
export function verifyUptimeKumaOverSsh(host, user) {
  errout.write(`[hdc] uptime-kuma configure: verifying systemd on ${user}@${host} …\n`);
  const r = sshRunAsUser(
    host,
    user,
    "systemctl is-active --quiet uptime-kuma && test -f /opt/uptime-kuma/package.json",
    { capture: true },
  );
  if (r.status !== 0) {
    return { ok: false, message: "uptime-kuma service not active or package missing" };
  }
  return { ok: true, message: "service active" };
}

/**
 * @param {Record<string, unknown>} uptimeKuma
 * @returns {string | null}
 */
export function resolvePublicUrlHostname(uptimeKuma) {
  const raw =
    typeof uptimeKuma.public_url === "string" && uptimeKuma.public_url.trim()
      ? uptimeKuma.public_url.trim()
      : "";
  if (!raw.startsWith("https://")) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ port: number; allowedCidrs: string[] }} OciAdminIngress
 */

/**
 * @param {unknown} oci
 * @returns {OciAdminIngress | null}
 */
export function resolveOciAdminIngress(oci) {
  if (!isObject(oci)) return null;
  const admin = isObject(oci.admin_ingress) ? oci.admin_ingress : null;
  if (!admin) return null;
  const port =
    typeof admin.port === "number" && Number.isFinite(admin.port) && admin.port > 0
      ? Math.trunc(admin.port)
      : 3001;
  const allowedCidrs = Array.isArray(admin.allowed_cidrs)
    ? admin.allowed_cidrs.map((c) => String(c).trim()).filter(Boolean)
    : [];
  if (!allowedCidrs.length) return null;
  return { port, allowedCidrs };
}

/**
 * @param {string} hostname
 * @param {OciAdminIngress | null} [adminIngress]
 */
export function buildCaddyInstallScript(hostname, adminIngress = null) {
  const adminPort = adminIngress?.port ?? 3001;
  const adminCidrs = adminIngress?.allowedCidrs ?? [];
  /** @type {string[]} */
  const adminIngressLines = [];
  if (adminCidrs.length) {
    adminIngressLines.push(
      "ensure_iptables_port_cidr() {",
      "  local port=\"$1\"",
      "  local cidr=\"$2\"",
      "  if ! iptables -C INPUT -p tcp -s \"$cidr\" -m state --state NEW -m tcp --dport \"$port\" -j ACCEPT 2>/dev/null; then",
      "    iptables -I INPUT -p tcp -s \"$cidr\" -m state --state NEW -m tcp --dport \"$port\" -j ACCEPT",
      "  fi",
      "  if [ -f /etc/iptables/rules.v4 ] && ! grep -F \"$cidr\" /etc/iptables/rules.v4 | grep -q \"tcp dpt:${port}\"; then",
      "    sed -i \"/-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT/a -A INPUT -p tcp -s ${cidr} -m state --state NEW -m tcp --dport ${port} -j ACCEPT\" /etc/iptables/rules.v4",
      "  fi",
      "}",
    );
    for (const cidr of adminCidrs) {
      const escaped = cidr.replace(/'/g, `'\\''`);
      adminIngressLines.push(`ensure_iptables_port_cidr ${adminPort} '${escaped}'`);
    }
  }

  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl ca-certificates",
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null",
    "apt-get update -qq",
    "apt-get install -y -qq caddy",
    "# OCI Ubuntu images iptables-reject all inbound except SSH; open 80/443 for Caddy.",
    "ensure_iptables_port() {",
    "  local port=\"$1\"",
    "  if ! iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport \"$port\" -j ACCEPT 2>/dev/null; then",
    "    iptables -I INPUT -p tcp -m state --state NEW -m tcp --dport \"$port\" -j ACCEPT",
    "  fi",
    "  if [ -f /etc/iptables/rules.v4 ] && ! grep -q \"tcp dpt:${port}\" /etc/iptables/rules.v4; then",
    "    sed -i \"/-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT/a -A INPUT -p tcp -m state --state NEW -m tcp --dport ${port} -j ACCEPT\" /etc/iptables/rules.v4",
    "  fi",
    "}",
    "ensure_iptables_port 80",
    "ensure_iptables_port 443",
    ...adminIngressLines,
    "if command -v netfilter-persistent >/dev/null 2>&1; then",
    "  netfilter-persistent save >/dev/null 2>&1 || true",
    "elif [ -f /etc/iptables/rules.v4 ]; then",
    "  iptables-save > /etc/iptables/rules.v4",
    "fi",
    "cat > /etc/caddy/Caddyfile <<'CADDYEOF'",
    `${hostname} {`,
    "  reverse_proxy 127.0.0.1:3001",
    "}",
    "CADDYEOF",
    "systemctl enable caddy",
    "systemctl reload caddy || systemctl restart caddy",
    "systemctl is-active --quiet caddy",
  ].join("\n");
}

/**
 * @param {string} host
 * @param {string} user
 * @param {string} hostname
 * @param {OciAdminIngress | null} [adminIngress]
 */
export async function installCaddyForOciVm(host, user, hostname, adminIngress = null) {
  errout.write(`[hdc] uptime-kuma caddy: TLS reverse proxy for ${hostname} on ${user}@${host} …\n`);
  const r = sshRunAsUser(host, user, buildCaddyInstallScript(hostname, adminIngress));
  if (r.status !== 0) {
    return { ok: false, message: `caddy install failed (exit ${r.status})`, hostname };
  }
  return { ok: true, message: "caddy active", hostname };
}

/**
 * @param {string} host
 * @param {string} user
 * @param {string} hostname
 * @param {OciAdminIngress | null} [adminIngress]
 */
export async function maintainCaddyForOciVm(host, user, hostname, adminIngress = null) {
  return installCaddyForOciVm(host, user, hostname, adminIngress);
}

/**
 * @param {Record<string, unknown>} configure
 */
export function resolveSshTargetFromConfigure(configure) {
  const ssh = isObject(configure?.ssh) ? configure.ssh : {};
  const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
  if (!host) return null;
  const preferred = typeof ssh.user === "string" && ssh.user.trim() ? ssh.user.trim() : "ubuntu";
  return resolveGuestSshTargetWithFallback({ host, preferredUser: preferred });
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
