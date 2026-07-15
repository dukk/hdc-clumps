import { stderr as errout } from "node:process";

import { growRootFilesystemScript } from "hdc/package/qemu-rootfs-resize.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  buildAudiobookshelfDataDiskMountScript,
  buildEnsureDataDirsScript,
  AUDIOBOOKSHELF_DOCKER_DATA_ROOT,
} from "./proxmox-data-disk.mjs";
import {
  composeDir,
  dataMount,
  renderAudiobookshelfEnv,
  renderComposeYaml,
  resolvePublicUrl,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./audiobookshelf-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} script
 */
function runRemoteBashScript(exec, script) {
  return exec.run(script, { capture: true });
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {{ dataDiskMountScript?: string; ensureDataDirsScript?: string; dockerDataRoot?: string; growRoot?: boolean }} [opts]
 */
export function buildInstallScript(composeDirPath, composeYaml, envContent, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
  ];
  if (opts.dataDiskMountScript) {
    lines.push(opts.dataDiskMountScript);
  } else if (opts.ensureDataDirsScript) {
    lines.push(opts.ensureDataDirsScript);
  }
  if (opts.growRoot !== false) {
    lines.push(growRootFilesystemScript());
  }
  if (opts.dockerDataRoot) {
    const dr = opts.dockerDataRoot.replace(/'/g, `'\\''`);
    lines.push(`mkdir -p '${dr}'`);
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
  );
  if (opts.dockerDataRoot) {
    const dr = opts.dockerDataRoot.replace(/'/g, `'\\''`);
    lines.push(
      "install -d /etc/docker",
      `printf '%s\\n' '{"data-root": "${dr}"}' > /etc/docker/daemon.json`,
      "if systemctl is-active --quiet docker 2>/dev/null; then systemctl stop docker; fi",
      "if [ -d /var/lib/docker ] && [ ! -L /var/lib/docker ]; then rm -rf /var/lib/docker/* 2>/dev/null || true; fi",
    );
  }
  lines.push(
    "systemctl enable --now docker",
    `mkdir -p '${dir}'`,
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
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
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, envContent, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}'`,
    `test -f '${dir}/docker-compose.yml'`,
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    `cd '${dir}'`,
  ];
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
 * @param {Record<string, unknown>} audiobookshelf
 * @param {Record<string, unknown>} install
 * @param {number} [dataDiskGb]
 */
export async function installAudiobookshelfOnHost(exec, audiobookshelf, install, dataDiskGb = 0) {
  errout.write(`[hdc] audiobookshelf install: Docker Compose via ${exec.label} …\n`);

  const dir = composeDir(install);
  const dm = dataMount(install);
  const composeYaml = renderComposeYaml();
  const envContent = renderAudiobookshelfEnv(audiobookshelf, install);
  const useDataDisk = dataDiskGb > 0;
  const inner = buildInstallScript(dir, composeYaml, envContent, {
    dataDiskMountScript: useDataDisk ? buildAudiobookshelfDataDiskMountScript(dm) : undefined,
    ensureDataDirsScript: !useDataDisk ? buildEnsureDataDirsScript(dm) : undefined,
    dockerDataRoot: useDataDisk ? AUDIOBOOKSHELF_DOCKER_DATA_ROOT : undefined,
    growRoot: true,
  });

  const r = runRemoteBashScript(exec, inner);
  if (r.status !== 0) {
    if (r.stderr.trim()) errout.write(`${r.stderr.trimEnd()}\n`);
    if (r.stdout.trim()) errout.write(`${r.stdout.trimEnd()}\n`);
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
      detail: `${r.stderr}${r.stdout}`.trim() || null,
    };
  }

  const ipOut = exec.run("hostname -I | awk '{print $1}'", { capture: true });
  const guestIp = ipOut.status === 0 ? ipOut.stdout.trim().split(/\s+/)[0] || null : null;
  errout.write(`[hdc] audiobookshelf install: completed on ${guestIp ?? "guest"}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    web_url: resolveWebUrl(audiobookshelf, guestIp),
    public_url: resolvePublicUrl(audiobookshelf),
    upstream_url: resolveUpstreamUrl(guestIp, audiobookshelf),
    guest_ip: guestIp,
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} audiobookshelf
 * @param {Record<string, unknown>} install
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainAudiobookshelfOnHost(exec, audiobookshelf, install, opts = {}) {
  errout.write(`[hdc] audiobookshelf maintain: refreshing stack via ${exec.label} …\n`);

  const dir = composeDir(install);
  const envContent = renderAudiobookshelfEnv(audiobookshelf, install);
  const inner = buildMaintainScript(dir, envContent, opts);
  const r = runRemoteBashScript(exec, inner);
  if (r.status !== 0) {
    if (r.stderr.trim()) errout.write(`${r.stderr.trimEnd()}\n`);
    if (r.stdout.trim()) errout.write(`${r.stdout.trimEnd()}\n`);
    return { ok: false, message: `stack maintain failed (exit ${r.status})` };
  }
  const ipOut = exec.run("hostname -I | awk '{print $1}'", { capture: true });
  const guestIp = ipOut.status === 0 ? ipOut.stdout.trim().split(/\s+/)[0] || null : null;
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    web_url: resolveWebUrl(audiobookshelf, guestIp),
    public_url: resolvePublicUrl(audiobookshelf),
    upstream_url: resolveUpstreamUrl(guestIp, audiobookshelf),
    guest_ip: guestIp,
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
