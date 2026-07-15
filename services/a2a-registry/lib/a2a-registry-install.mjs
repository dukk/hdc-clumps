import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  composeDir,
  renderComposeYaml,
  renderDockerfile,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./a2a-registry-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {string} dockerfile
 * @param {string} composeYaml
 * @param {{ build?: boolean }} [opts]
 */
export function buildStackScript(composeDirPath, dockerfile, composeYaml, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
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
    `cat > '${dir}/Dockerfile' <<'HDDOCKERFILE'`,
    dockerfile.trimEnd(),
    "HDDOCKERFILE",
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cd '${dir}'`,
  ];
  if (opts.build !== false) {
    lines.push("docker compose build");
  }
  lines.push("docker compose up -d", "docker compose ps");
  return lines.join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} dockerfile
 * @param {string} composeYaml
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, dockerfile, composeYaml, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}'`,
    `cat > '${dir}/Dockerfile' <<'HDDOCKERFILE'`,
    dockerfile.trimEnd(),
    "HDDOCKERFILE",
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cd '${dir}'`,
  ];
  if (!opts.skipUpgrade) {
    lines.push("docker compose build");
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
 * @param {Record<string, unknown>} a2aRegistry
 * @param {Record<string, unknown>} install
 */
export async function installA2aRegistryInCt(user, pveHost, vmid, a2aRegistry, install) {
  errout.write(`[hdc] a2a-registry install: Docker Compose build in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "a2a-registry install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const dockerfile = renderDockerfile(a2aRegistry);
  const composeYaml = renderComposeYaml(a2aRegistry, install);
  const dir = composeDir(install);
  const inner = buildStackScript(dir, dockerfile, composeYaml);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  errout.write(`[hdc] a2a-registry install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    url: resolveWebUrl(a2aRegistry, ip),
    upstream_url: resolveUpstreamUrl(ip, a2aRegistry),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} a2aRegistry
 * @param {Record<string, unknown>} install
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainA2aRegistryInCt(user, pveHost, vmid, a2aRegistry, install, opts = {}) {
  errout.write(`[hdc] a2a-registry maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "a2a-registry maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const dockerfile = renderDockerfile(a2aRegistry);
  const composeYaml = renderComposeYaml(a2aRegistry, install);
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, dockerfile, composeYaml, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "image rebuilt",
    url: resolveWebUrl(a2aRegistry, ip),
    upstream_url: resolveUpstreamUrl(ip, a2aRegistry),
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
