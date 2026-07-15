import { stderr as errout } from "node:process";

import { growRootFilesystemScript } from "hdc/package/qemu-rootfs-resize.mjs";
import {
  composeDir,
  composeFileUrl,
  envExampleUrl,
  renderImmichEnv,
  resolvePublicUrl,
} from "./immich-render.mjs";
import { buildImmichDataDiskMountScript } from "./proxmox-data-disk.mjs";

/**
 * @param {string} composeDirPath
 * @param {string} composeUrl
 * @param {string} envExample
 * @param {string} envContent hdc-rendered .env (overwrites example)
 * @param {string[]} mkdirPaths
 * @param {string} [dataDiskMountScript]
 * @param {string} [dockerDataRoot] when set, store container images on this path (e.g. /data/immich/docker)
 */
export function buildInstallScript(
  composeDirPath,
  composeUrl,
  envExample,
  envContent,
  mkdirPaths,
  dataDiskMountScript,
  dockerDataRoot,
) {
  const escapedCompose = composeUrl.replace(/'/g, `'\\''`);
  const escapedEnv = envExample.replace(/'/g, `'\\''`);
  const dir = composeDirPath.replace(/'/g, `'\\''`);

  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
  ];
  if (dataDiskMountScript) {
    lines.push(dataDiskMountScript);
  }
  lines.push(growRootFilesystemScript());
  for (const p of mkdirPaths) {
    const mp = p.replace(/'/g, `'\\''`);
    lines.push(`mkdir -p '${mp}'`);
  }
  if (dockerDataRoot) {
    const dr = dockerDataRoot.replace(/'/g, `'\\''`);
    lines.push(
      `mkdir -p '${dr}'`,
      "install -d /etc/docker",
      `printf '%s\\n' '{"data-root": "${dr}"}' > /etc/docker/daemon.json`,
      "if systemctl is-active --quiet docker 2>/dev/null; then systemctl stop docker; fi",
      "if [ -d /var/lib/docker ] && [ ! -L /var/lib/docker ]; then rm -rf /var/lib/docker/* 2>/dev/null || true; fi",
    );
  }
  lines.push(
    "apt-get update -qq",
    "apt-get install -y -qq ca-certificates curl gnupg",
    "if ! command -v docker >/dev/null 2>&1; then",
    "  install -m 0755 -d /etc/apt/keyrings",
    "  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "  chmod a+r /etc/apt/keyrings/docker.asc",
    '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME:-$VERSION_ID}) stable" > /etc/apt/sources.list.d/docker.list',
    "  apt-get update -qq",
    "  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin",
    "fi",
    "systemctl enable --now docker",
    `mkdir -p '${dir}'`,
    `curl -fsSL '${escapedCompose}' -o '${dir}/docker-compose.yml'`,
    `curl -fsSL '${escapedEnv}' -o '${dir}/.env.example'`,
    `cat > '${dir}/.env' <<'HDCIMMICHENV'`,
    envContent.trimEnd(),
    "HDCIMMICHENV",
    `cd '${dir}'`,
    "docker compose pull",
    "docker compose up -d",
    "docker compose ps",
  );
  return lines.join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} envContent
 * @param {{ skipUpgrade?: boolean; composeUrl?: string; envExampleUrl?: string }} [opts]
 */
export function buildMaintainScript(composeDirPath, envContent, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}'`,
    `test -f '${dir}/docker-compose.yml'`,
  ];
  if (!opts.skipUpgrade && opts.composeUrl) {
    const escapedCompose = opts.composeUrl.replace(/'/g, `'\\''`);
    lines.push(`curl -fsSL '${escapedCompose}' -o '${dir}/docker-compose.yml'`);
    if (opts.envExampleUrl) {
      const escapedEnv = opts.envExampleUrl.replace(/'/g, `'\\''`);
      lines.push(`curl -fsSL '${escapedEnv}' -o '${dir}/.env.example'`);
    }
  }
  lines.push(
    `cat > '${dir}/.env' <<'HDCIMMICHENV'`,
    envContent.trimEnd(),
    "HDCIMMICHENV",
    `cd '${dir}'`,
  );
  if (!opts.skipUpgrade) {
    lines.push("docker compose pull");
  }
  lines.push("docker compose up -d", "docker compose ps");
  return lines.join("\n");
}

/**
 * @param {string} composeDirPath
 */
export function buildComposeDownScript(composeDirPath) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `if test -f '${dir}/docker-compose.yml'; then`,
    `  cd '${dir}' && docker compose down 2>/dev/null || true`,
    "fi",
  ].join("\n");
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} immich
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {number} dataDiskGb
 */
export async function installImmichOnHost(exec, immich, install, dbPassword, dataDiskGb) {
  errout.write(`[hdc] immich install: ${exec.label} …\n`);

  const release = typeof immich.release === "string" ? immich.release : "latest";
  const dir = composeDir(install);
  const envContent = renderImmichEnv(immich, install, dbPassword);
  const upload =
    typeof immich.upload_location === "string" ? immich.upload_location.trim() : "./library";
  const dbLoc =
    typeof immich.db_data_location === "string" ? immich.db_data_location.trim() : "./postgres";
  const mkdirPaths = [
    dir,
    upload.startsWith("/") ? upload : `${dir}/${upload.replace(/^\.\//, "")}`,
    dbLoc.startsWith("/") ? dbLoc : `${dir}/${dbLoc.replace(/^\.\//, "")}`,
  ];
  if (dataDiskGb > 0) {
    mkdirPaths.push("/data/immich", "/data/immich/library", "/data/immich/postgres");
  }

  const dataDiskScript =
    dataDiskGb > 0 ? buildImmichDataDiskMountScript("/data/immich") : undefined;
  const dockerDataRoot = dataDiskGb > 0 ? "/data/immich/docker" : undefined;
  const inner = buildInstallScript(
    dir,
    composeFileUrl(release),
    envExampleUrl(release),
    envContent,
    [...new Set(mkdirPaths)],
    dataDiskScript,
    dockerDataRoot,
  );

  const r = exec.run(inner);
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, method: "docker-compose", message: detail };
  }

  const sshHost = exec.label.match(/@([^:]+)$/)?.[1] ?? null;
  const webUrl = resolvePublicUrl(immich, sshHost);
  errout.write(`[hdc] immich install: completed on ${exec.label}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    compose_dir: dir,
    web_url: webUrl,
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} immich
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {{ skipUpgrade?: boolean; dataDiskGb?: number }} [opts]
 */
export async function maintainImmichOnHost(exec, immich, install, dbPassword, opts = {}) {
  errout.write(`[hdc] immich maintain: ${exec.label} …\n`);

  if (opts.dataDiskGb && opts.dataDiskGb > 0) {
    const mountScript = buildImmichDataDiskMountScript("/data/immich");
    const mr = exec.run(mountScript);
    if (mr.status !== 0) {
      const detail = `${mr.stderr}${mr.stdout}`.trim() || `exit ${mr.status}`;
      return { ok: false, message: `data disk mount: ${detail}` };
    }
  }

  const envContent = renderImmichEnv(immich, install, dbPassword);
  const dir = composeDir(install);
  const release = typeof immich.release === "string" ? immich.release : "latest";
  const inner = buildMaintainScript(dir, envContent, {
    skipUpgrade: opts.skipUpgrade,
    composeUrl: composeFileUrl(release),
    envExampleUrl: envExampleUrl(release),
  });
  const r = exec.run(inner);
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, message: detail };
  }

  const sshHost = exec.label.match(/@([^:]+)$/)?.[1] ?? null;
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    web_url: resolvePublicUrl(immich, sshHost),
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} install
 */
export function composeDownOnHost(exec, install) {
  const dir = composeDir(install);
  exec.run(buildComposeDownScript(dir));
}
