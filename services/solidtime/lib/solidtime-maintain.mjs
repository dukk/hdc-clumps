import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { normalizeVersionTag } from "./deployments.mjs";
import {
  buildInstallScript,
  buildSolidtimeKeysBashLines,
  buildSolidtimeProductionEnvBashLines,
  buildSolidtimeProxyEnvBashLines,
  buildSolidtimeSystemdUnitsBashLines,
  fetchLatestReleaseTag,
  isSolidtimeHttpsAppUrl,
  readInstalledVersion,
  releaseTarballUrl,
} from "./solidtime-install.mjs";
import { solidtimeMailEnvBashSnippet } from "hdc/package/app-mail-render.mjs";

/**
 * Apply mail relay settings to /opt/solidtime/.env (idempotent).
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} solidtime
 */
export function applySolidtimeMailInCt(user, pveHost, vmid, solidtime) {
  const inner = solidtimeMailEnvBashSnippet(solidtime);
  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim();
    return { ok: false, message: detail || `exit ${r.status}` };
  }
  return { ok: true, message: "mail settings applied" };
}

/**
 * Apply reverse-proxy HTTPS env (APP_FORCE_HTTPS, SESSION_SECURE_COOKIE, TRUSTED_PROXIES)
 * from solidtime.app_url, then clear Laravel caches.
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} solidtime
 */
export function applySolidtimeProxyEnvInCt(user, pveHost, vmid, solidtime) {
  const appUrl =
    typeof solidtime.app_url === "string" && solidtime.app_url.trim() ? solidtime.app_url.trim() : "";
  const https = isSolidtimeHttpsAppUrl(appUrl);
  const inner = [
    "set -euo pipefail",
    ...buildSolidtimeProxyEnvBashLines("/opt/solidtime/.env", https),
    "cd /opt/solidtime",
    'export PATH="/usr/local/bin:$PATH"',
    "php artisan optimize:clear",
  ].join("\n");
  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim();
    return {
      ok: false,
      https,
      message: detail || `exit ${r.status}`,
    };
  }
  return {
    ok: true,
    https,
    message: https
      ? "proxy HTTPS env applied (APP_FORCE_HTTPS, TRUSTED_PROXIES)"
      : "proxy env applied (HTTP / LAN defaults)",
  };
}

/**
 * Ensure APP_KEY + Passport file keys (strip bad PASSPORT_* env).
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function ensureSolidtimeKeysInCt(user, pveHost, vmid) {
  const inner = ["set -euo pipefail", ...buildSolidtimeKeysBashLines(), "php artisan optimize:clear"].join(
    "\n",
  );
  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim();
    return { ok: false, message: detail || `exit ${r.status}` };
  }
  return { ok: true, message: "passport keys ensured (storage/oauth-*.key)" };
}

/**
 * QUEUE_CONNECTION=database, clear GOTENBERG_URL, storage:link.
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function ensureSolidtimeProductionEnvInCt(user, pveHost, vmid) {
  const inner = [
    "set -euo pipefail",
    ...buildSolidtimeProductionEnvBashLines("/opt/solidtime/.env"),
    "php artisan optimize:clear",
  ].join("\n");
  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim();
    return { ok: false, message: detail || `exit ${r.status}` };
  }
  return { ok: true, message: "production env applied (queue/database, storage:link, gotenberg cleared)" };
}

/**
 * Ensure queue worker + scheduler systemd units are installed and active.
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function ensureSolidtimeSystemdInCt(user, pveHost, vmid) {
  const inner = ["set -euo pipefail", ...buildSolidtimeSystemdUnitsBashLines()].join("\n");
  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim();
    return { ok: false, message: detail || `exit ${r.status}` };
  }
  return { ok: true, message: "solidtime-queue + solidtime-scheduler.timer active" };
}

/**
 * Compare semver-like tags (v0.12.1 vs v0.12.2). Returns positive if a > b.
 * @param {string} a
 * @param {string} b
 */
export function compareVersionTags(a, b) {
  const strip = (t) =>
    String(t)
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((x) => parseInt(x, 10) || 0);
  const pa = strip(a);
  const pb = strip(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * @param {string} tag
 */
export function buildUpgradeScript(tag) {
  const version = normalizeVersionTag(tag);
  const tarballUrl = releaseTarballUrl(version);
  const qVersion = `'${version.replace(/'/g, `'\\''`)}'`;
  const qTarball = `'${tarballUrl.replace(/'/g, `'\\''`)}'`;

  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "test -d /opt/solidtime",
    `TARGET_VERSION=${qVersion}`,
    `TARBALL_URL=${qTarball}`,
    "",
    "systemctl stop caddy",
    "",
    "cp /opt/solidtime/.env /opt/solidtime.env.bak",
    "rm -rf /opt/solidtime_storage_backup",
    "cp -a /opt/solidtime/storage /opt/solidtime_storage_backup",
    "",
    "rm -rf /opt/solidtime",
    "mkdir -p /opt/solidtime",
    "curl -fsSL \"$TARBALL_URL\" -o /tmp/solidtime-src.tar.gz",
    "tar -xzf /tmp/solidtime-src.tar.gz -C /tmp",
    "SRC_DIR=$(find /tmp -maxdepth 1 -type d -name 'solidtime-*' | head -1)",
    'test -n "$SRC_DIR" && test -d "$SRC_DIR"',
    'cp -a "$SRC_DIR"/. /opt/solidtime/',
    "rm -rf /tmp/solidtime-src.tar.gz /tmp/solidtime-*",
    "",
    "cp /opt/solidtime.env.bak /opt/solidtime/.env",
    "rm -f /opt/solidtime.env.bak",
    "rm -rf /opt/solidtime/storage",
    "cp -a /opt/solidtime_storage_backup /opt/solidtime/storage",
    "rm -rf /opt/solidtime_storage_backup",
    "",
    "cd /opt/solidtime",
    'export PATH="/usr/local/bin:$PATH"',
    "/usr/local/bin/composer install --no-dev --optimize-autoloader",
    "npm install",
    "npm run build",
    "php artisan migrate --force",
    ...buildSolidtimeKeysBashLines(),
    "php artisan storage:link || true",
    "test -e /opt/solidtime/public/storage || php artisan storage:link",
    "php artisan optimize:clear",
    "chown -R www-data:www-data /opt/solidtime",
    `echo "$TARGET_VERSION" > /opt/solidtime/.hdc-installed-version`,
    "",
    "systemctl start caddy",
    ...buildSolidtimeSystemdUnitsBashLines(),
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} solidtime
 * @param {{ checkLatest?: boolean; versionOverride?: string; skipUpgrade?: boolean }} opts
 */
export async function maintainSolidtimeInCt(user, pveHost, vmid, solidtime, opts = {}) {
  if (opts.skipUpgrade) {
    return { ok: true, upgraded: false, message: "upgrade skipped" };
  }

  const ready = await waitForCt(user, pveHost, vmid, 2000, "solidtime maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const check = pctExec(user, pveHost, vmid, "test -d /opt/solidtime && echo yes", { capture: true });
  if (check.status !== 0 || check.stdout.trim() !== "yes") {
    return { ok: false, message: "No SolidTime installation found in /opt/solidtime" };
  }

  const configured = normalizeVersionTag(
    opts.versionOverride ||
      (typeof solidtime.version === "string" ? solidtime.version : "") ||
      "v0.12.2",
  );
  const installed = readInstalledVersion(user, pveHost, vmid);
  let targetVersion = configured;

  if (opts.checkLatest) {
    const latest = await fetchLatestReleaseTag();
    if (latest) {
      targetVersion = normalizeVersionTag(latest);
      errout.write(`[hdc] solidtime maintain: latest GitHub release ${targetVersion}\n`);
    }
  }

  if (installed && compareVersionTags(targetVersion, installed) <= 0) {
    return {
      ok: true,
      upgraded: false,
      installed_version: installed,
      target_version: targetVersion,
      message: "already up to date",
    };
  }

  errout.write(
    `[hdc] solidtime maintain: upgrading CT ${vmid} ${installed ?? "unknown"} → ${targetVersion} …\n`,
  );

  const inner = buildUpgradeScript(targetVersion);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      upgraded: false,
      installed_version: installed,
      target_version: targetVersion,
      message: `upgrade failed (exit ${r.status})`,
    };
  }

  return {
    ok: true,
    upgraded: true,
    installed_version: targetVersion,
    previous_version: installed,
    target_version: targetVersion,
    message: "upgraded",
  };
}
