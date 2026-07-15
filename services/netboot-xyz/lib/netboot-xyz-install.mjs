import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { webAppPort } from "./deployments.mjs";
import {
  composeDir,
  renderComposeYaml,
  resolveWebUiUrl,
} from "./netboot-xyz-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 */
export function buildInstallScript(composeDirPath, composeYaml) {
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
    `mkdir -p '${dir}/config' '${dir}/assets'`,
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cd '${dir}'`,
    "docker compose pull",
    "docker compose up -d",
    "docker compose ps",
  ].join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, composeYaml, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `test -f '${dir}/docker-compose.yml'`,
    `mkdir -p '${dir}/config' '${dir}/assets'`,
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
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
    "echo 'netboot.xyz web UI did not become ready in time' >&2",
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
 * @param {Record<string, unknown>} netbootXyz
 */
async function waitForWebUi(user, pveHost, vmid, netbootXyz) {
  const port = webAppPort(netbootXyz);
  errout.write(`[hdc] netboot-xyz install: waiting for HTTP on port ${port} in CT ${vmid} …\n`);
  const inner = buildWaitHttpScript(port);
  const r = pctExec(user, pveHost, vmid, inner);
  return r.status === 0;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} netbootXyz
 * @param {Record<string, unknown>} install
 */
export async function installNetbootXyzInCt(user, pveHost, vmid, netbootXyz, install) {
  errout.write(`[hdc] netboot-xyz install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "netboot-xyz install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const composeYaml = renderComposeYaml(netbootXyz, install);
  const dir = composeDir(install);
  const inner = buildInstallScript(dir, composeYaml);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  const httpReady = await waitForWebUi(user, pveHost, vmid, netbootXyz);
  if (!httpReady) {
    return {
      ok: false,
      method: "docker-compose",
      message: "netboot.xyz web UI did not become ready",
    };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const uiUrl = resolveWebUiUrl(ip, netbootXyz);
  errout.write(`[hdc] netboot-xyz install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    web_ui_url: uiUrl,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} netbootXyz
 * @param {Record<string, unknown>} install
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainNetbootXyzInCt(user, pveHost, vmid, netbootXyz, install, opts = {}) {
  errout.write(`[hdc] netboot-xyz maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "netboot-xyz maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const composeYaml = renderComposeYaml(netbootXyz, install);
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, composeYaml, { skipUpgrade: opts.skipUpgrade });
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
