import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { hostPort } from "./deployments.mjs";
import {
  buildFetchSettingsScript,
  composeDir,
  renderComposeYaml,
  renderSearxngEnv,
  resolvePublicUrl,
} from "./searxng-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {Record<string, unknown>} searxng
 */
export function buildInstallScript(composeDirPath, composeYaml, envContent, searxng) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);

  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq ca-certificates curl gnupg python3",
    "if ! command -v docker >/dev/null 2>&1; then",
    "  install -m 0755 -d /etc/apt/keyrings",
    "  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "  chmod a+r /etc/apt/keyrings/docker.asc",
    '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME:-$VERSION_ID}) stable" > /etc/apt/sources.list.d/docker.list',
    "  apt-get update -qq",
    "  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin",
    "fi",
    "systemctl enable --now docker",
    buildFetchSettingsScript(composeDirPath, searxng),
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
 * @param {string} envContent
 * @param {Record<string, unknown>} searxng
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, envContent, searxng, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `test -f '${dir}/docker-compose.yml'`,
    buildFetchSettingsScript(composeDirPath, searxng),
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
    `  cd '${dir}' && docker compose down -v 2>/dev/null || true`,
    "fi",
  ].join("\n");
}

/**
 * @param {number} port
 * @param {number} [timeoutMs]
 */
export function buildWaitHttpScript(port, timeoutMs = 300000) {
  const deadline = Math.max(30, Math.floor(timeoutMs / 1000));
  return [
    "set -euo pipefail",
    `port=${port}`,
    `deadline=$(( $(date +%s) + ${deadline} ))`,
    "while [ \"$(date +%s)\" -lt \"$deadline\" ]; do",
    "  if curl -sf --max-time 5 \"http://127.0.0.1:${port}/\" -o /dev/null; then",
    "    exit 0",
    "  fi",
    "  sleep 3",
    "done",
    "echo 'SearXNG HTTP did not become ready in time' >&2",
    "exit 1",
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
 * @param {Record<string, unknown>} searxng
 */
async function waitForSearxngHttp(user, pveHost, vmid, searxng) {
  const port = hostPort(searxng);
  errout.write(`[hdc] searxng install: waiting for HTTP on port ${port} in CT ${vmid} …\n`);
  const inner = buildWaitHttpScript(port);
  const r = pctExec(user, pveHost, vmid, inner);
  return r.status === 0;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} searxng
 * @param {Record<string, unknown>} install
 * @param {string} secret
 */
export async function installSearxngInCt(user, pveHost, vmid, searxng, install, secret) {
  errout.write(`[hdc] searxng install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "searxng install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const envContent = renderSearxngEnv(searxng, secret);
  const composeYaml = renderComposeYaml();
  const dir = composeDir(install);
  const inner = buildInstallScript(dir, composeYaml, envContent, searxng);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  const httpReady = await waitForSearxngHttp(user, pveHost, vmid, searxng);
  if (!httpReady) {
    return {
      ok: false,
      method: "docker-compose",
      message: "SearXNG HTTP did not become ready",
    };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const publicUrl = resolvePublicUrl(searxng, ip);
  errout.write(`[hdc] searxng install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    public_url: publicUrl,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} searxng
 * @param {Record<string, unknown>} install
 * @param {string} secret
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainSearxngInCt(user, pveHost, vmid, searxng, install, secret, opts = {}) {
  errout.write(`[hdc] searxng maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "searxng maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const envContent = renderSearxngEnv(searxng, secret);
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, envContent, searxng, { skipUpgrade: opts.skipUpgrade });
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }

  return { ok: true, message: "stack refreshed" };
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
