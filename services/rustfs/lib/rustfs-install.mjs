import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  buildRustfsVolumesEnv,
  composeDir,
  drivesPerNode,
  renderComposeYaml,
  renderEnvFile,
  resolveConsoleLanUrl,
  resolveConsoleUpstreamUrl,
  resolveS3LanUrl,
  resolveS3UpstreamUrl,
  s3Port,
} from "./rustfs-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {number} drives
 */
function dataDirMkdirLines(composeDirPath, drives) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const parts = [];
  for (let i = 1; i <= drives; i += 1) {
    parts.push(`'${dir}/data/rustfs${i}'`);
  }
  return [`mkdir -p ${parts.join(" ")} '${dir}/logs'`, `chown -R 10001:10001 '${dir}/data' '${dir}/logs'`];
}

/**
 * @param {string} composeDirPath
 * @param {number} drives
 * @param {string} composeYaml
 * @param {string} envContent
 */
export function buildInstallScript(composeDirPath, drives, composeYaml, envContent) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);

  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
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
    ...dataDirMkdirLines(composeDirPath, drives),
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
  ].join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {number} drives
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, drives, composeYaml, envContent, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}'`,
    ...dataDirMkdirLines(composeDirPath, drives),
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
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
 * @param {number} s3Port
 */
export function buildHealthWaitScript(s3Port) {
  const port = Number.isFinite(s3Port) && s3Port > 0 ? Math.floor(s3Port) : 9000;
  return [
    "set -euo pipefail",
    `port=${port}`,
    "for i in $(seq 1 60); do",
    '  if curl -sf --max-time 5 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then',
    "    echo ok",
    "    exit 0",
    "  fi",
    "  sleep 2",
    "done",
    "echo 'rustfs health wait timed out'",
    "exit 1",
  ].join("\n");
}

/**
 * @param {string} composeDirPath
 */
export function buildComposeDownScript(composeDirPath) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `if test -f '${dir}/docker-compose.yml'; then`,
    `  cd '${dir}' && docker compose down -v 2>/dev/null || true`,
    "fi",
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
 * @param {Record<string, unknown>} rustfs
 * @param {Record<string, unknown>} install
 * @param {{ peers: { hostname: string }[]; accessKey: string; secretKey: string; waitHealth?: boolean }} ctx
 */
export async function installRustfsInCt(user, pveHost, vmid, rustfs, install, ctx) {
  errout.write(`[hdc] rustfs install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "rustfs install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const volumes = buildRustfsVolumesEnv(ctx.peers, rustfs);
  const composeYaml = renderComposeYaml(rustfs);
  const envContent = renderEnvFile(rustfs, volumes, ctx.accessKey, ctx.secretKey);
  const dir = composeDir(install);
  const drives = drivesPerNode(rustfs);
  const inner = buildInstallScript(dir, drives, composeYaml, envContent);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  if (ctx.waitHealth !== false) {
    errout.write(`[hdc] rustfs install: waiting for S3 health on CT ${vmid} …\n`);
    const waitScript = buildHealthWaitScript(s3Port(rustfs));
    const wr = pctExec(user, pveHost, vmid, waitScript, { capture: true });
    if (wr.status !== 0) {
      return {
        ok: false,
        method: "docker-compose",
        message: `health wait failed on CT ${vmid}: ${(wr.stderr || wr.stdout).trim()}`,
      };
    }
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  errout.write(`[hdc] rustfs install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    rustfs_volumes: volumes,
    s3_url: resolveS3LanUrl(rustfs, ip),
    console_url: resolveConsoleLanUrl(rustfs, ip),
    upstream_s3: resolveS3UpstreamUrl(ip, rustfs),
    upstream_console: resolveConsoleUpstreamUrl(ip, rustfs),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} rustfs
 * @param {Record<string, unknown>} install
 * @param {{ peers: { hostname: string }[]; accessKey: string; secretKey: string; skipUpgrade?: boolean }} ctx
 */
export async function maintainRustfsInCt(user, pveHost, vmid, rustfs, install, ctx) {
  errout.write(`[hdc] rustfs maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "rustfs maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const volumes = buildRustfsVolumesEnv(ctx.peers, rustfs);
  const composeYaml = renderComposeYaml(rustfs);
  const envContent = renderEnvFile(rustfs, volumes, ctx.accessKey, ctx.secretKey);
  const dir = composeDir(install);
  const drives = drivesPerNode(rustfs);
  const inner = buildMaintainScript(dir, drives, composeYaml, envContent, {
    skipUpgrade: ctx.skipUpgrade,
  });
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  return {
    ok: true,
    message: ctx.skipUpgrade ? "restarted" : "images refreshed",
    rustfs_volumes: volumes,
    s3_url: resolveS3LanUrl(rustfs, ip),
    console_url: resolveConsoleLanUrl(rustfs, ip),
    upstream_s3: resolveS3UpstreamUrl(ip, rustfs),
    upstream_console: resolveConsoleUpstreamUrl(ip, rustfs),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} install
 */
export function composeDownInCt(user, pveHost, vmid, install) {
  const dir = composeDir(install);
  const inner = buildComposeDownScript(dir);
  pctExec(user, pveHost, vmid, inner);
}
