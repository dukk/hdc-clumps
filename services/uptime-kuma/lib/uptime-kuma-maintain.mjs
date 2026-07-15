import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import {
  compareVersions,
  normalizeReleaseTag,
  resolveReleaseTarget,
} from "./uptime-kuma-release.mjs";
import {
  CHROMIUM_SYMLINK_SHELL,
  readInstalledReleaseTag,
  readInstalledReleaseTagOverSsh,
  sshRunAsUser,
} from "./uptime-kuma-install.mjs";

/**
 * @param {string} tag
 * @param {string} tarballUrl
 */
export function buildUpgradeScript(tag, tarballUrl) {
  const escapedUrl = tarballUrl.replace(/'/g, `'\\''`);
  const escapedTag = tag.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    "if [ ! -d /opt/uptime-kuma ]; then",
    "  echo 'No Uptime Kuma installation found' >&2",
    "  exit 1",
    "fi",
    "systemctl stop uptime-kuma",
    `curl -fL# -o /tmp/uptime-kuma-${escapedTag}.tar.gz '${escapedUrl}'`,
    "rm -rf /opt/uptime-kuma/* /opt/uptime-kuma/.[!.]* 2>/dev/null || true",
    `tar -xzf /tmp/uptime-kuma-${escapedTag}.tar.gz -C /opt/uptime-kuma --strip-components=1`,
    `rm -f /tmp/uptime-kuma-${escapedTag}.tar.gz`,
    "cd /opt/uptime-kuma",
    "npm install --omit=dev",
    "npm run download-dist",
    ...CHROMIUM_SYMLINK_SHELL,
    `echo '${escapedTag}' > /opt/uptime-kuma/.hdc-release-tag`,
    "systemctl start uptime-kuma",
    "systemctl is-active --quiet uptime-kuma",
  ].join("\n");
}

export function buildHealthCheckScript() {
  return [
    "set -euo pipefail",
    "systemctl restart uptime-kuma",
    "systemctl is-active --quiet uptime-kuma",
  ].join("\n");
}

export function buildHealthVerifyScript() {
  return [
    "set -euo pipefail",
    "systemctl is-active --quiet uptime-kuma",
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} uptimeKuma
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainUptimeKumaInCt(user, pveHost, vmid, uptimeKuma, opts = {}) {
  errout.write(`[hdc] uptime-kuma maintain: CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "uptime-kuma maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  if (opts.skipUpgrade) {
    errout.write(`[hdc] uptime-kuma maintain: --skip-upgrade — health verify only (no restart) …\n`);
    const r = pctExec(user, pveHost, vmid, buildHealthVerifyScript());
    if (r.status !== 0) {
      return { ok: false, message: `health check failed (exit ${r.status})`, upgraded: false };
    }
    return { ok: true, message: "healthy", upgraded: false };
  }

  const installed = readInstalledReleaseTag(user, pveHost, vmid);
  const releaseSpec =
    typeof uptimeKuma.release === "string" && uptimeKuma.release.trim()
      ? uptimeKuma.release.trim()
      : "latest";

  let targetTag;
  let tarballUrl;
  try {
    const resolved = await resolveReleaseTarget(releaseSpec);
    targetTag = normalizeReleaseTag(resolved.tag);
    tarballUrl = resolved.tarballUrl;
  } catch (e) {
    return { ok: false, message: String(/** @type {Error} */ (e).message || e), upgraded: false };
  }

  const current = installed ? normalizeReleaseTag(installed) : null;
  if (current && compareVersions(current, targetTag) >= 0) {
    errout.write(
      `[hdc] uptime-kuma maintain: already at ${current} (target ${targetTag}) — restart only …\n`,
    );
    const r = pctExec(user, pveHost, vmid, buildHealthCheckScript());
    if (r.status !== 0) {
      return {
        ok: false,
        message: `restart failed (exit ${r.status})`,
        upgraded: false,
        installed: current,
        target: targetTag,
      };
    }
    return {
      ok: true,
      message: "up to date",
      upgraded: false,
      installed: current,
      target: targetTag,
    };
  }

  errout.write(
    `[hdc] uptime-kuma maintain: upgrading ${current ?? "unknown"} → ${targetTag} …\n`,
  );
  const inner = buildUpgradeScript(targetTag, tarballUrl);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      message: `upgrade failed (exit ${r.status})`,
      upgraded: false,
      installed: current,
      target: targetTag,
    };
  }
  return {
    ok: true,
    message: "upgraded",
    upgraded: true,
    installed: current,
    target: targetTag,
  };
}

/**
 * @param {string} host
 * @param {string} user
 * @param {Record<string, unknown>} uptimeKuma
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainUptimeKumaOverSsh(host, user, uptimeKuma, opts = {}) {
  errout.write(`[hdc] uptime-kuma maintain: ${user}@${host} …\n`);

  if (opts.skipUpgrade) {
    errout.write(`[hdc] uptime-kuma maintain: --skip-upgrade — health verify only (no restart) …\n`);
    const r = sshRunAsUser(host, user, buildHealthVerifyScript());
    if (r.status !== 0) {
      return { ok: false, message: `health check failed (exit ${r.status})`, upgraded: false };
    }
    return { ok: true, message: "healthy", upgraded: false };
  }

  const installed = readInstalledReleaseTagOverSsh(host, user);
  const releaseSpec =
    typeof uptimeKuma.release === "string" && uptimeKuma.release.trim()
      ? uptimeKuma.release.trim()
      : "latest";

  let targetTag;
  let tarballUrl;
  try {
    const resolved = await resolveReleaseTarget(releaseSpec);
    targetTag = normalizeReleaseTag(resolved.tag);
    tarballUrl = resolved.tarballUrl;
  } catch (e) {
    return { ok: false, message: String(/** @type {Error} */ (e).message || e), upgraded: false };
  }

  const current = installed ? normalizeReleaseTag(installed) : null;
  if (current && compareVersions(current, targetTag) >= 0) {
    const r = sshRunAsUser(host, user, buildHealthCheckScript());
    if (r.status !== 0) {
      return {
        ok: false,
        message: `restart failed (exit ${r.status})`,
        upgraded: false,
        installed: current,
        target: targetTag,
      };
    }
    return {
      ok: true,
      message: "up to date",
      upgraded: false,
      installed: current,
      target: targetTag,
    };
  }

  const inner = buildUpgradeScript(targetTag, tarballUrl);
  const r = sshRunAsUser(host, user, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      message: `upgrade failed (exit ${r.status})`,
      upgraded: false,
      installed: current,
      target: targetTag,
    };
  }
  return {
    ok: true,
    message: "upgraded",
    upgraded: true,
    installed: current,
    target: targetTag,
  };
}
