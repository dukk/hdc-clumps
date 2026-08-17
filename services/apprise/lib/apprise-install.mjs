import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  composeDir,
  dataDirs,
  hostPort,
  renderComposeYaml,
  resolveAppriseKeys,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./apprise-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {{ config: string; plugin: string; attach: string }} dirs
 * @param {string} composeYaml
 */
export function buildInstallScript(composeDirPath, dirs, composeYaml) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const config = dirs.config.replace(/'/g, `'\\''`);
  const plugin = dirs.plugin.replace(/'/g, `'\\''`);
  const attach = dirs.attach.replace(/'/g, `'\\''`);

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
    `mkdir -p '${dir}' '${config}' '${plugin}' '${attach}'`,
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
 * @param {{ config: string; plugin: string; attach: string }} dirs
 * @param {string} composeYaml
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, dirs, composeYaml, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const config = dirs.config.replace(/'/g, `'\\''`);
  const plugin = dirs.plugin.replace(/'/g, `'\\''`);
  const attach = dirs.attach.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}' '${config}' '${plugin}' '${attach}'`,
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
 * @param {{ id: string; urls: string[] }[]} keys
 * @param {number} port
 */
export function buildSeedKeysScript(keys, port) {
  const listen = Number.isFinite(port) && port > 0 ? Math.floor(port) : 8000;
  const lines = [
    "set -euo pipefail",
    `for i in $(seq 1 30); do curl -sf --max-time 3 http://127.0.0.1:${listen}/status >/dev/null && break; sleep 2; done`,
    `curl -sf --max-time 5 http://127.0.0.1:${listen}/status >/dev/null || { echo 'apprise /status not ready' >&2; exit 1; }`,
  ];
  for (const key of keys) {
    const id = String(key.id || "").trim();
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error(`invalid apprise key id ${JSON.stringify(key.id)}`);
    }
    const urls = (key.urls || []).map((u) => String(u).trim()).filter(Boolean);
    if (!urls.length) continue;
    const joined = urls.join(" ").replace(/'/g, `'\\''`);
    lines.push(
      `curl -sf --max-time 15 -X POST --data-urlencode 'urls=${joined}' http://127.0.0.1:${listen}/add/${id} >/dev/null`,
      `echo seeded_key=${id}`,
    );
  }
  return lines.join("\n");
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
 * @param {Record<string, unknown>} apprise
 * @param {Record<string, unknown>} install
 */
export async function installAppriseInCt(user, pveHost, vmid, apprise, install) {
  errout.write(`[hdc] apprise install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "apprise install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const composeYaml = renderComposeYaml(apprise, install);
  const dirs = dataDirs(install);
  const dir = composeDir(install);
  const inner = buildInstallScript(dir, dirs, composeYaml);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  errout.write(`[hdc] apprise install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    url: resolveWebUrl(apprise, ip),
    upstream_url: resolveUpstreamUrl(ip, apprise),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} apprise
 * @param {Record<string, unknown>} install
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainAppriseInCt(user, pveHost, vmid, apprise, install, opts = {}) {
  errout.write(`[hdc] apprise maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "apprise maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const composeYaml = renderComposeYaml(apprise, install);
  const dirs = dataDirs(install);
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, dirs, composeYaml, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    url: resolveWebUrl(apprise, ip),
    upstream_url: resolveUpstreamUrl(ip, apprise),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} apprise
 * @param {{ host: string; port?: number; from: string }} relay
 */
export function seedAppriseKeysInCt(user, pveHost, vmid, apprise, relay) {
  const keys = resolveAppriseKeys(apprise, relay).filter((k) => k.urls.length);
  if (!keys.length) {
    return { ok: true, skipped: true, message: "no keys with urls", seeded: [] };
  }
  errout.write(
    `[hdc] apprise keys: seeding ${keys.map((k) => k.id).join(", ")} on CT ${vmid} …\n`,
  );
  const inner = buildSeedKeysScript(keys, hostPort(apprise));
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `seed keys failed (exit ${r.status})` };
  }
  return { ok: true, message: "seeded", seeded: keys.map((k) => k.id) };
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
