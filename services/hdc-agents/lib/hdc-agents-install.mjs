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
} from "./hdc-agents-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {string} dockerfile
 * @param {string} composeYaml
 * @param {{ build?: boolean, composeEnv?: string, schedulesJson?: string, mailboxJson?: string, notificationsJson?: string, metaRoot?: string }} [opts]
 */
export function buildStackScript(composeDirPath, dockerfile, composeYaml, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const meta = (opts.metaRoot || "/opt/hdc-agents-meta").replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq ca-certificates curl gnupg rsync",
    "if ! command -v docker >/dev/null 2>&1; then",
    "  install -m 0755 -d /etc/apt/keyrings",
    "  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "  chmod a+r /etc/apt/keyrings/docker.asc",
    '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME:-$VERSION_ID}) stable" > /etc/apt/sources.list.d/docker.list',
    "  apt-get update -qq",
    "  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin",
    "fi",
    "systemctl enable --now docker",
    `mkdir -p '${dir}/hdc' /opt/hdc-private/operations/tasks /opt/hdc-src '${meta}/logs'`,
    "if test -d /opt/hdc-src/apps; then",
    `  rsync -a --delete --exclude node_modules --exclude .git /opt/hdc-src/ '${dir}/hdc/'`,
    "elif test -d /opt/hdc/apps; then",
    `  rsync -a --delete --exclude node_modules --exclude .git /opt/hdc/ '${dir}/hdc/'`,
    "fi",
    `cat > '${dir}/Dockerfile' <<'HDDOCKERFILE'`,
    dockerfile.trimEnd(),
    "HDDOCKERFILE",
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
  ];
  if (opts.composeEnv) {
    const b64 = Buffer.from(opts.composeEnv, "utf8").toString("base64");
    lines.push(`echo '${b64}' | base64 -d > '${dir}/.env'`);
    lines.push(`chmod 600 '${dir}/.env'`);
    lines.push(`echo '${b64}' | base64 -d > '${meta}/.env'`);
    lines.push(`chmod 600 '${meta}/.env'`);
  }
  if (opts.schedulesJson) {
    const b64 = Buffer.from(opts.schedulesJson, "utf8").toString("base64");
    lines.push(`echo '${b64}' | base64 -d > '${meta}/schedules.json'`);
  }
  if (opts.mailboxJson) {
    const b64 = Buffer.from(opts.mailboxJson, "utf8").toString("base64");
    lines.push(`echo '${b64}' | base64 -d > '${meta}/mailbox.json'`);
  }
  if (opts.notificationsJson) {
    const b64 = Buffer.from(opts.notificationsJson, "utf8").toString("base64");
    lines.push(`echo '${b64}' | base64 -d > '${meta}/notifications.json'`);
  }
  lines.push(`cd '${dir}'`);
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
 * @param {{ skipUpgrade?: boolean, composeEnv?: string, schedulesJson?: string, mailboxJson?: string, notificationsJson?: string, metaRoot?: string }} [opts]
 */
export function buildMaintainScript(composeDirPath, dockerfile, composeYaml, opts = {}) {
  return buildStackScript(composeDirPath, dockerfile, composeYaml, {
    build: !opts.skipUpgrade,
    composeEnv: opts.composeEnv,
    schedulesJson: opts.schedulesJson,
    mailboxJson: opts.mailboxJson,
    notificationsJson: opts.notificationsJson,
    metaRoot: opts.metaRoot,
  });
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
 * @param {Record<string, unknown>} hdcAgents
 * @param {Record<string, unknown>} install
 * @param {{ composeEnv?: string, schedulesJson?: string, metaRoot?: string }} [opts]
 */
export async function installHdcAgentsInCt(user, pveHost, vmid, hdcAgents, install, opts = {}) {
  errout.write(`[hdc] hdc-agents install: Docker Compose build in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "hdc-agents install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const dir = composeDir(install);
  const dockerfile = renderDockerfile(hdcAgents);
  const composeYaml = renderComposeYaml(hdcAgents, install, { guestIp: ip });
  const script = buildStackScript(dir, dockerfile, composeYaml, {
    build: true,
    composeEnv: opts.composeEnv,
    schedulesJson: opts.schedulesJson,
    mailboxJson: opts.mailboxJson,
    notificationsJson: opts.notificationsJson,
    metaRoot: opts.metaRoot,
  });
  const r = pctExec(user, pveHost, vmid, script, { capture: true });
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: (r.stderr || r.stdout || `exit ${r.status}`).slice(0, 2000),
    };
  }

  return {
    ok: true,
    method: "docker-compose",
    compose_dir: dir,
    guest_ip: ip,
    upstream_url: resolveUpstreamUrl(ip, hdcAgents),
    web_url: resolveWebUrl(ip, hdcAgents),
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} hdcAgents
 * @param {Record<string, unknown>} install
 * @param {{ skipUpgrade?: boolean, composeEnv?: string, schedulesJson?: string, metaRoot?: string }} [opts]
 */
export async function maintainHdcAgentsInCt(user, pveHost, vmid, hdcAgents, install, opts = {}) {
  errout.write(`[hdc] hdc-agents maintain: re-push compose in CT ${vmid} …\n`);
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const dir = composeDir(install);
  const dockerfile = renderDockerfile(hdcAgents);
  const composeYaml = renderComposeYaml(hdcAgents, install, { guestIp: ip });
  const script = buildMaintainScript(dir, dockerfile, composeYaml, opts);
  const r = pctExec(user, pveHost, vmid, script, { capture: true });
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: (r.stderr || r.stdout || `exit ${r.status}`).slice(0, 2000),
    };
  }
  return {
    ok: true,
    method: "docker-compose",
    compose_dir: dir,
    guest_ip: ip,
    upstream_url: resolveUpstreamUrl(ip, hdcAgents),
    web_url: resolveWebUrl(ip, hdcAgents),
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} install
 */
export async function composeDownHdcAgentsInCt(user, pveHost, vmid, install) {
  const script = buildComposeDownScript(composeDir(install));
  const r = pctExec(user, pveHost, vmid, script, { capture: true });
  return { ok: r.status === 0, status: r.status };
}
