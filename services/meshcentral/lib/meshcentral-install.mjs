import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  buildConfigPatchScript,
  composeDir,
  renderComposeYaml,
  renderMeshcentralEnv,
  serviceSummary,
} from "./meshcentral-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 */
export function buildInstallScript(composeDirPath, composeYaml, envContent, meshcentral) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const configPatch = buildConfigPatchScript(composeDirPath, meshcentral);

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
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    `cd '${dir}'`,
    "docker compose pull",
    "docker compose up -d",
    configPatch,
    "docker compose ps",
  ].join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, composeYaml, envContent, meshcentral, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const configPatch = buildConfigPatchScript(composeDirPath, meshcentral);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}'`,
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
  lines.push("docker compose up -d", configPatch, "docker compose ps");
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
 * @param {Record<string, unknown>} meshcentral
 * @param {Record<string, unknown>} install
 * @param {string} mongoPassword
 */
export async function installMeshcentralInCt(user, pveHost, vmid, meshcentral, install, mongoPassword) {
  errout.write(`[hdc] meshcentral install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "meshcentral install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const composeYaml = renderComposeYaml(meshcentral);
  const envContent = renderMeshcentralEnv(meshcentral, mongoPassword);
  const dir = composeDir(install);
  const inner = buildInstallScript(dir, composeYaml, envContent, meshcentral);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  const summary = serviceSummary(ip, meshcentral);
  errout.write(`[hdc] meshcentral install: completed on CT ${vmid}.\n`);
  if (summary.public_url) {
    errout.write(`[hdc] meshcentral install: service URL ${JSON.stringify(summary.public_url)}.\n`);
  }

  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    ct_ip: ip,
    ...summary,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} meshcentral
 * @param {Record<string, unknown>} install
 * @param {string} mongoPassword
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainMeshcentralInCt(
  user,
  pveHost,
  vmid,
  meshcentral,
  install,
  mongoPassword,
  opts = {},
) {
  errout.write(`[hdc] meshcentral maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "meshcentral maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const composeYaml = renderComposeYaml(meshcentral);
  const envContent = renderMeshcentralEnv(meshcentral, mongoPassword);
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, composeYaml, envContent, meshcentral, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }

  const summary = serviceSummary(ip, meshcentral);
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    ct_ip: ip,
    ...summary,
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
