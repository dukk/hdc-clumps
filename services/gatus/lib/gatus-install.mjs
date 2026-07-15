import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { resolvePveSshForHost, waitForCt } from "../../pi-hole/lib/pi-hole-install.mjs";
import { gatusConfigPath } from "./gatus-render.mjs";

export { resolvePveSshForHost, waitForCt };

const GITHUB_TARBALL = "https://github.com/TwiN/gatus/tarball";

/**
 * @param {unknown} version
 */
export function normalizeGatusVersion(version) {
  const t = typeof version === "string" ? version.trim() : "";
  if (!t || t === "latest") return "v5.36.0";
  if (/^v\d/.test(t)) return t;
  if (/^\d/.test(t)) return `v${t}`;
  throw new Error(`gatus.version must be a release tag like v5.36.0 (got ${JSON.stringify(version)})`);
}

/**
 * @param {string} tag
 */
export function gatusTarballUrl(tag) {
  return `${GITHUB_TARBALL}/${encodeURIComponent(tag)}`;
}

/**
 * @param {Record<string, unknown>} gatus
 * @param {{ upgrade?: boolean }} [opts]
 */
export function buildInstallScript(gatus, opts = {}) {
  const tag = normalizeGatusVersion(gatus.version);
  const configPath = gatusConfigPath(gatus);
  const upgrade = opts.upgrade === true;

  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq curl ca-certificates golang-go libcap2-bin",
  ];

  if (upgrade) {
    lines.push(
      "systemctl stop gatus 2>/dev/null || true",
      `[ -f ${configPath} ] && cp -a ${configPath} /tmp/gatus-config.yaml.bak || true`,
    );
  }

  lines.push(
    "rm -rf /opt/gatus /tmp/gatus-src",
    "mkdir -p /opt/gatus/config /tmp/gatus-src",
    `curl -fsSL ${gatusTarballUrl(tag)} -o /tmp/gatus-src.tar.gz`,
    "tar -xzf /tmp/gatus-src.tar.gz -C /tmp/gatus-src --strip-components=1",
    "cd /tmp/gatus-src",
    "go mod tidy",
    "CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o /opt/gatus/gatus .",
    "setcap cap_net_raw+ep /opt/gatus/gatus",
    "[ -f /tmp/gatus-config.yaml.bak ] && mv /tmp/gatus-config.yaml.bak /opt/gatus/config/config.yaml || true",
    "rm -rf /tmp/gatus-src /tmp/gatus-src.tar.gz",
  );

  if (!upgrade) {
    lines.push(
      `[ ! -f ${configPath} ] && echo 'endpoints: []' > ${configPath} || true`,
    );
  }

  lines.push(
    `cat > /etc/systemd/system/gatus.service <<'UNIT'`,
    "[Unit]",
    "Description=Gatus health dashboard",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=/opt/gatus",
    `Environment=GATUS_CONFIG_PATH=${configPath}`,
    "ExecStart=/opt/gatus/gatus",
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "systemctl daemon-reload",
    "systemctl enable gatus",
    "systemctl restart gatus",
    "sleep 2",
    "systemctl is-active --quiet gatus",
    "test -x /opt/gatus/gatus",
  );

  return lines.join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} gatus
 * @param {{ upgrade?: boolean }} [opts]
 */
export async function installGatusInCt(user, pveHost, vmid, gatus, opts = {}) {
  const label = opts.upgrade ? "upgrade" : "install";
  errout.write(`[hdc] gatus ${label}: building Gatus in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, `gatus ${label}`);
  if (!ready) {
    return { ok: false, method: label, message: `CT ${vmid} not reachable via pct exec` };
  }

  const inner = buildInstallScript(gatus, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: label,
      message: `${label} failed (exit ${r.status})`,
      stderr: r.stderr?.slice(0, 800),
    };
  }
  errout.write(`[hdc] gatus ${label}: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: label,
    message: label === "upgrade" ? "upgraded" : "installed",
    version: normalizeGatusVersion(gatus.version),
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} gatus
 */
export function upgradeGatusInCt(user, pveHost, vmid, gatus) {
  return installGatusInCt(user, pveHost, vmid, gatus, { upgrade: true });
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function gatusInstalled(user, pveHost, vmid) {
  const r = pctExec(
    user,
    pveHost,
    vmid,
    "test -x /opt/gatus/gatus && systemctl list-unit-files gatus.service >/dev/null 2>&1 && echo yes",
    { capture: true },
  );
  return r.status === 0 && r.stdout.trim() === "yes";
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
export function readGatusVersionInCt(user, pveHost, vmid) {
  const r = pctExec(
    user,
    pveHost,
    vmid,
    "/opt/gatus/gatus --version 2>/dev/null | head -1 || true",
    { capture: true },
  );
  if (r.status !== 0) return null;
  const line = r.stdout.trim();
  return line || null;
}
