import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { normalizeTrivyVersion } from "./deployments.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} version
 */
export function trivyTarballUrl(version) {
  return `https://github.com/aquasecurity/trivy/releases/download/${encodeURIComponent(version)}/trivy_${version.replace(/^v/, "")}_Linux-64bit.tar.gz`;
}

/**
 * @param {Record<string, unknown>} trivy
 * @param {{ upgrade?: boolean }} [opts]
 */
export function buildInstallScript(trivy, opts = {}) {
  const version = normalizeTrivyVersion(trivy);
  const url = trivyTarballUrl(version);
  const upgrade = opts.upgrade === true;
  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq curl ca-certificates tar",
  ];
  if (upgrade) lines.push("systemctl stop trivy-scan.timer trivy-scan.service 2>/dev/null || true");
  lines.push(
    "rm -rf /tmp/trivy-install",
    "mkdir -p /tmp/trivy-install",
    `curl -fsSL ${url} -o /tmp/trivy-install/trivy.tar.gz`,
    "tar -xzf /tmp/trivy-install/trivy.tar.gz -C /tmp/trivy-install trivy",
    "install -m 0755 /tmp/trivy-install/trivy /usr/local/bin/trivy",
    "rm -rf /tmp/trivy-install",
    "trivy --version >/dev/null",
  );
  return lines.join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} trivy
 * @param {{ upgrade?: boolean }} [opts]
 */
export async function installTrivyInCt(user, pveHost, vmid, trivy, opts = {}) {
  const label = opts.upgrade ? "upgrade" : "install";
  errout.write(`[hdc] trivy ${label}: configuring CT ${vmid} ...\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, `trivy ${label}`);
  if (!ready) return { ok: false, method: label, message: `CT ${vmid} not reachable via pct exec` };
  const r = pctExec(user, pveHost, vmid, buildInstallScript(trivy, opts));
  if (r.status !== 0) {
    return { ok: false, method: label, message: `${label} failed (exit ${r.status})`, stderr: r.stderr?.slice(0, 800) };
  }
  return { ok: true, method: label, message: label === "upgrade" ? "upgraded" : "installed", version: normalizeTrivyVersion(trivy) };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} trivy
 */
export function maintainTrivyInCt(user, pveHost, vmid, trivy) {
  return installTrivyInCt(user, pveHost, vmid, trivy, { upgrade: true });
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function trivyInstalled(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "command -v trivy >/dev/null 2>&1 && echo yes", { capture: true });
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
export function readTrivyVersionInCt(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "trivy --version 2>/dev/null | head -1 || true", { capture: true });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}
