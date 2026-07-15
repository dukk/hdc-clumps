import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  clientConfigSummary,
  composeDir,
  dataDir,
  renderComposeYaml,
  resolveIdServerHost,
} from "./rustdesk-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {string} dataDirPath
 * @param {string} composeYaml
 */
export function buildInstallScript(composeDirPath, dataDirPath, composeYaml) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const data = dataDirPath.replace(/'/g, `'\\''`);

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
    `mkdir -p '${dir}' '${data}'`,
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
 * @param {string} dataDirPath
 * @param {string} composeYaml
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, dataDirPath, composeYaml, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const data = dataDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}' '${data}'`,
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
 * @param {Record<string, unknown>} install
 */
export function readPublicKey(user, pveHost, vmid, install) {
  const path = `${dataDir(install)}/id_ed25519.pub`;
  const r = pctExec(user, pveHost, vmid, `cat ${JSON.stringify(path)} 2>/dev/null || true`, {
    capture: true,
  });
  if (r.status !== 0) return null;
  const key = r.stdout.trim();
  return key || null;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} rustdesk
 * @param {Record<string, unknown>} install
 */
export async function installRustdeskInCt(user, pveHost, vmid, rustdesk, install) {
  errout.write(`[hdc] rustdesk install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "rustdesk install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const composeYaml = renderComposeYaml(rustdesk, install);
  const dir = composeDir(install);
  const data = dataDir(install);
  const inner = buildInstallScript(dir, data, composeYaml);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  const publicKey = readPublicKey(user, pveHost, vmid, install);
  const client = clientConfigSummary(ip, publicKey, rustdesk);

  errout.write(`[hdc] rustdesk install: completed on CT ${vmid}.\n`);
  if (client.id_server && client.public_key) {
    errout.write(
      `[hdc] rustdesk install: client ID server ${JSON.stringify(client.id_server)} — public key generated.\n`,
    );
  } else if (client.id_server) {
    errout.write(
      `[hdc] rustdesk install: client ID server ${JSON.stringify(client.id_server)} — public key not yet readable (may appear after hbbs starts).\n`,
    );
  }

  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    ct_ip: ip,
    id_server: client.id_server,
    public_key: client.public_key,
    client,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} rustdesk
 * @param {Record<string, unknown>} install
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainRustdeskInCt(user, pveHost, vmid, rustdesk, install, opts = {}) {
  errout.write(`[hdc] rustdesk maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "rustdesk maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const composeYaml = renderComposeYaml(rustdesk, install);
  const dir = composeDir(install);
  const data = dataDir(install);
  const inner = buildMaintainScript(dir, data, composeYaml, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }

  const publicKey = readPublicKey(user, pveHost, vmid, install);
  const client = clientConfigSummary(ip, publicKey, rustdesk);

  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    ct_ip: ip,
    id_server: resolveIdServerHost(ip, rustdesk),
    public_key: publicKey,
    client,
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
