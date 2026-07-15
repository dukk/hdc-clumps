import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { httpPort } from "./deployments.mjs";
import {
  composeDir,
  renderComposeYaml,
  renderYacyEnv,
  resolvePublicUrl,
} from "./yacy-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} s
 */
function shellSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 */
export function buildInstallScript(composeDirPath, composeYaml, envContent) {
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
    "echo 'YaCy HTTP did not become ready in time' >&2",
    "exit 1",
  ].join("\n");
}

/**
 * @param {string} password
 */
export function buildSetAdminPasswordScript(password) {
  const q = shellSingleQuote(password);
  return [
    "set -euo pipefail",
    "if ! docker ps --format '{{.Names}}' | grep -qx yacy; then",
    "  echo 'yacy container not running' >&2",
    "  exit 1",
    "fi",
    `docker exec yacy /opt/yacy_search_server/bin/passwd.sh ${q}`,
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
 * @param {Record<string, unknown>} yacy
 */
async function waitForYacyHttp(user, pveHost, vmid, yacy) {
  const port = httpPort(yacy);
  errout.write(`[hdc] yacy install: waiting for HTTP on port ${port} in CT ${vmid} …\n`);
  const inner = buildWaitHttpScript(port);
  const r = pctExec(user, pveHost, vmid, inner);
  return r.status === 0;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} adminPassword
 */
export async function setAdminPasswordInCt(user, pveHost, vmid, adminPassword) {
  if (!adminPassword || adminPassword.length <= 2) {
    return { ok: false, message: "admin password must be longer than 2 characters" };
  }
  errout.write(`[hdc] yacy install: setting admin password in CT ${vmid} …\n`);
  const inner = buildSetAdminPasswordScript(adminPassword);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout).trim();
    return {
      ok: false,
      message: `passwd.sh failed (exit ${r.status})${detail ? `: ${detail}` : ""}`,
    };
  }
  errout.write(`[hdc] yacy install: admin password applied in CT ${vmid}.\n`);
  return { ok: true, message: "admin password set" };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} yacy
 * @param {Record<string, unknown>} install
 * @param {{ adminPassword?: string | null; skipAdminPassword?: boolean }} [opts]
 */
export async function installYacyInCt(user, pveHost, vmid, yacy, install, opts = {}) {
  errout.write(`[hdc] yacy install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "yacy install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const envContent = renderYacyEnv(yacy);
  const composeYaml = renderComposeYaml();
  const dir = composeDir(install);
  const inner = buildInstallScript(dir, composeYaml, envContent);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  const httpReady = await waitForYacyHttp(user, pveHost, vmid, yacy);
  if (!httpReady) {
    return {
      ok: false,
      method: "docker-compose",
      message: "YaCy HTTP did not become ready",
    };
  }

  /** @type {{ ok: boolean; message?: string } | null} */
  let passwordResult = null;
  if (!opts.skipAdminPassword && opts.adminPassword) {
    passwordResult = await setAdminPasswordInCt(user, pveHost, vmid, opts.adminPassword);
    if (!passwordResult.ok) {
      return {
        ok: false,
        method: "docker-compose",
        message: passwordResult.message ?? "admin password failed",
        public_url: resolvePublicUrl(yacy, readCtPrimaryIp(user, pveHost, vmid)),
      };
    }
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const publicUrl = resolvePublicUrl(yacy, ip);
  errout.write(`[hdc] yacy install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    public_url: publicUrl,
    admin_password: passwordResult?.ok ? "set" : opts.skipAdminPassword ? "skipped" : "not_set",
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} yacy
 * @param {Record<string, unknown>} install
 * @param {{ adminPassword?: string | null; skipAdminPassword?: boolean; skipUpgrade?: boolean }} [opts]
 */
export async function maintainYacyInCt(user, pveHost, vmid, yacy, install, opts = {}) {
  errout.write(`[hdc] yacy maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "yacy maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const envContent = renderYacyEnv(yacy);
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, envContent, { skipUpgrade: opts.skipUpgrade });
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }

  if (!opts.skipAdminPassword && opts.adminPassword) {
    const pr = await setAdminPasswordInCt(user, pveHost, vmid, opts.adminPassword);
    if (!pr.ok) {
      return { ok: false, message: pr.message ?? "admin password failed" };
    }
  }

  return { ok: true, message: "images refreshed" };
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
