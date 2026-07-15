import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  composeDir,
  renderAffineCopilotConfig,
  renderComposeYaml,
  renderFullEnv,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./affine-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {string | null} [copilotConfigJson]
 */
export function buildInstallScript(composeDirPath, composeYaml, envContent, copilotConfigJson = null) {
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
    `mkdir -p '${dir}/postgres' '${dir}/storage' '${dir}/config'`,
    `mkdir -p '${dir}'`,
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
  ];

  if (typeof copilotConfigJson === "string" && copilotConfigJson.trim()) {
    lines.push(
      `cat > '${dir}/config/config.json' <<'HDCOPILOT'`,
      copilotConfigJson.trimEnd(),
      "HDCOPILOT",
    );
  }

  lines.push(`cd '${dir}'`, "docker compose pull", "docker compose up -d", "docker compose ps");
  return lines.join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {{ skipUpgrade?: boolean; copilotConfigJson?: string | null }} [opts]
 */
export function buildMaintainScript(composeDirPath, composeYaml, envContent, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}/postgres' '${dir}/storage' '${dir}/config'`,
    `mkdir -p '${dir}'`,
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
  ];

  if (typeof opts.copilotConfigJson === "string" && opts.copilotConfigJson.trim()) {
    lines.push(
      `cat > '${dir}/config/config.json' <<'HDCOPILOT'`,
      opts.copilotConfigJson.trimEnd(),
      "HDCOPILOT",
    );
  }

  lines.push(`cd '${dir}'`);
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
 * @param {Record<string, unknown>} affine
 * @param {{ dbPassword: string; copilotApiKey?: string }} secrets
 */
function resolveCopilotConfigJson(affine, secrets) {
  return renderAffineCopilotConfig(affine, secrets);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} affine
 * @param {Record<string, unknown>} install
 * @param {{ dbPassword: string; copilotApiKey?: string }} secrets
 */
export async function installAffineInCt(user, pveHost, vmid, affine, install, secrets) {
  errout.write(`[hdc] affine install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "affine install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const dir = composeDir(install);
  const envContent = renderFullEnv(affine, secrets, dir);
  const composeYaml = renderComposeYaml();
  const copilotConfigJson = resolveCopilotConfigJson(affine, secrets);
  if (copilotConfigJson) {
    errout.write(`[hdc] affine install: writing Copilot config.json (LiteLLM) …\n`);
  }
  const inner = buildInstallScript(dir, composeYaml, envContent, copilotConfigJson);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  errout.write(`[hdc] affine install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    url: resolveWebUrl(affine, ip),
    upstream_url: resolveUpstreamUrl(ip, affine),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} affine
 * @param {Record<string, unknown>} install
 * @param {{ dbPassword: string; copilotApiKey?: string }} secrets
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainAffineInCt(user, pveHost, vmid, affine, install, secrets, opts = {}) {
  errout.write(`[hdc] affine maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "affine maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const dir = composeDir(install);
  const envContent = renderFullEnv(affine, secrets, dir);
  const composeYaml = renderComposeYaml();
  const copilotConfigJson = resolveCopilotConfigJson(affine, secrets);
  if (copilotConfigJson) {
    errout.write(`[hdc] affine maintain: writing Copilot config.json (LiteLLM) …\n`);
  }
  const inner = buildMaintainScript(dir, composeYaml, envContent, {
    skipUpgrade: opts.skipUpgrade,
    copilotConfigJson,
  });
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    url: resolveWebUrl(affine, ip),
    upstream_url: resolveUpstreamUrl(ip, affine),
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
