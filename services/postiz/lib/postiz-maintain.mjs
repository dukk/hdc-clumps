import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { normalizeReleaseTag, resolveReleaseTarget } from "./postiz-release.mjs";
import { appDir, resolveAccessUrl } from "./postiz-render.mjs";
import { readCtPrimaryIp, readInstalledVersion } from "./postiz-install.mjs";

/**
 * Compare semver-like tags. Returns positive if a > b.
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
 * @param {string} appDirPath
 * @param {string} tag
 * @param {string} tarballUrl
 */
export function buildUpgradeScript(appDirPath, tag, tarballUrl) {
  const dir = appDirPath.replace(/'/g, `'\\''`);
  const qTag = `'${tag.replace(/'/g, `'\\''`)}'`;
  const qTarball = `'${tarballUrl.replace(/'/g, `'\\''`)}'`;

  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    `test -d '${dir}'`,
    "",
    "systemctl stop postiz-orchestrator postiz-frontend postiz-backend",
    "",
    `cp '${dir}/.env' /opt/postiz_env.bak`,
    `cp -r '${dir}/uploads' /opt/postiz_uploads.bak 2>/dev/null || true`,
    "",
    `rm -rf '${dir}'`,
    `mkdir -p '${dir}'`,
    `curl -fsSL ${qTarball} -o /tmp/postiz-src.tar.gz`,
    "tar -xzf /tmp/postiz-src.tar.gz -C /tmp",
    "SRC_DIR=$(find /tmp -maxdepth 1 -type d -name 'postiz-app-*' -o -name 'postiz-*' | head -1)",
    'test -n "$SRC_DIR" && test -d "$SRC_DIR"',
    `cp -a "$SRC_DIR"/. '${dir}/'`,
    "rm -rf /tmp/postiz-src.tar.gz /tmp/postiz-app-* /tmp/postiz-*",
    "",
    `cp /opt/postiz_env.bak '${dir}/.env'`,
    "rm -f /opt/postiz_env.bak",
    "",
    `cd '${dir}'`,
    "PNPM_VERSION=$(sed -n 's/.*\"packageManager\":\\s*\"pnpm@\\([^\"]*\\)\".*/\\1/p' package.json)",
    'test -n "$PNPM_VERSION"',
    "command -v pnpm >/dev/null 2>&1 || npm install -g \"pnpm@${PNPM_VERSION}\"",
    "",
    "set -a && source .env && set +a",
    "export NODE_OPTIONS=\"--max-old-space-size=4096\"",
    "pnpm install",
    "pnpm run build",
    "unset NODE_OPTIONS",
    "",
    `cd '${dir}'`,
    "set -a && source .env && set +a",
    "pnpm run prisma-db-push",
    "",
    `mkdir -p '${dir}/uploads'`,
    `cp -r /opt/postiz_uploads.bak/. '${dir}/uploads/' 2>/dev/null || true`,
    "rm -rf /opt/postiz_uploads.bak",
    "",
    "systemctl start postiz-backend postiz-frontend postiz-orchestrator",
    `echo ${qTag} > '${dir}/.hdc-installed-version'`,
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} postiz
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {string} jwtSecret
 * @param {string} envContent
 * @param {{ checkLatest?: boolean; versionOverride?: string }} opts
 */
export async function maintainPostizUpgradeInCt(
  user,
  pveHost,
  vmid,
  postiz,
  install,
  dbPassword,
  jwtSecret,
  envContent,
  opts = {},
) {
  const ready = await waitForCt(user, pveHost, vmid, 2000, "postiz maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const dir = appDir(install);
  const check = pctExec(user, pveHost, vmid, `test -d ${dir} && echo yes`, { capture: true });
  if (check.status !== 0 || check.stdout.trim() !== "yes") {
    return { ok: false, message: "No Postiz installation found in /opt/postiz" };
  }

  const configured =
    opts.versionOverride ||
    (typeof postiz.version === "string" ? postiz.version : "") ||
    "latest";
  const installed = readInstalledVersion(user, pveHost, vmid);
  let targetRelease = await resolveReleaseTarget(configured);

  if (opts.checkLatest) {
    targetRelease = await resolveReleaseTarget("latest");
    errout.write(`[hdc] postiz maintain: latest GitHub release ${targetRelease.tag}\n`);
  }

  const targetTag = normalizeReleaseTag(targetRelease.tag);
  if (installed && compareVersionTags(targetTag, installed) <= 0) {
    const ip = readCtPrimaryIp(user, pveHost, vmid);
    return {
      ok: true,
      upgraded: false,
      installed_version: installed,
      target_version: targetTag,
      access_url: resolveAccessUrl(postiz, ip),
      message: "already up to date",
    };
  }

  errout.write(
    `[hdc] postiz maintain: upgrading CT ${vmid} ${installed ?? "unknown"} → ${targetTag} …\n`,
  );

  const pushEnv = [
    "set -euo pipefail",
    `cat > '${dir.replace(/'/g, `'\\''`)}/.env' <<'HDCPOSTIZENV'`,
    envContent.trimEnd(),
    "HDCPOSTIZENV",
  ].join("\n");
  pctExec(user, pveHost, vmid, pushEnv);

  const inner = buildUpgradeScript(dir, targetTag, targetRelease.tarballUrl);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      upgraded: false,
      installed_version: installed,
      target_version: targetTag,
      message: `upgrade failed (exit ${r.status})`,
    };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  return {
    ok: true,
    upgraded: true,
    installed_version: targetTag,
    previous_version: installed,
    target_version: targetTag,
    access_url: resolveAccessUrl(postiz, ip),
    message: "upgraded",
  };
}
