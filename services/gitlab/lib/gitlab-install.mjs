import { createInterface } from "node:readline/promises";
import { stdin, stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  composeDir,
  renderComposeYaml,
  resolveSshCloneHint,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./gitlab-render.mjs";
import { createGitlabVaultAccess } from "./vault-deps.mjs";

export { resolvePveSshForHost };

const ROOT_PASSWORD_VAULT_KEY = "HDC_GITLAB_ROOT_PASSWORD";
const HEALTH_POLL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 20 * 60 * 1000;

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
    `mkdir -p '${dir}'`,
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
    `mkdir -p '${dir}'`,
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
 * @param {number} hostPort
 */
export function buildHealthCheckScript(hostPort) {
  return `curl -sf --max-time 10 http://127.0.0.1:${hostPort}/-/health -o /dev/null && echo ok || echo fail`;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {number} hostPort
 */
export async function waitForGitlabHealth(user, pveHost, vmid, hostPort) {
  const started = Date.now();
  let attempt = 0;
  errout.write(
    `[hdc] gitlab install: waiting for /-/health on CT ${vmid} (timeout ${HEALTH_TIMEOUT_MS / 60000} min) …\n`,
  );
  while (Date.now() - started < HEALTH_TIMEOUT_MS) {
    attempt += 1;
    const r = pctExec(user, pveHost, vmid, buildHealthCheckScript(hostPort), { capture: true });
    if (r.status === 0 && r.stdout.trim() === "ok") {
      errout.write(`[hdc] gitlab install: health check passed (attempt ${attempt}).\n`);
      return true;
    }
    errout.write(`[hdc] gitlab install: not ready yet (attempt ${attempt}) …\n`);
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  errout.write(`[hdc] gitlab install: health check timed out on CT ${vmid}.\n`);
  return false;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function readInitialRootPassword(user, pveHost, vmid) {
  const cmd = [
    "docker exec gitlab test -f /etc/gitlab/initial_root_password",
    "&& docker exec gitlab sed -n 's/^Password: //p' /etc/gitlab/initial_root_password",
    "|| true",
  ].join(" ");
  const r = pctExec(user, pveHost, vmid, cmd, { capture: true });
  if (r.status !== 0) return null;
  const pw = r.stdout.trim();
  return pw || null;
}

/**
 * @param {string} password
 */
async function maybeSaveRootPasswordToVault(password) {
  if (!password) return;
  if (!stdin.isTTY) {
    errout.write(
      `[hdc] gitlab install: initial root password available in container /etc/gitlab/initial_root_password (not a TTY — save vault ${ROOT_PASSWORD_VAULT_KEY} manually).\n`,
    );
    return;
  }
  const rl = createInterface({ input: stdin, output: errout });
  let answer;
  try {
    answer = (await rl.question(`Save initial root password to vault ${ROOT_PASSWORD_VAULT_KEY}? [y/N] `))
      .trim()
      .toLowerCase();
  } finally {
    rl.close();
  }
  if (!answer.startsWith("y")) {
    errout.write(
      `[hdc] gitlab install: root password not saved — retrieve from container /etc/gitlab/initial_root_password (expires ~24h after first boot).\n`,
    );
    return;
  }
  try {
    const vault = createGitlabVaultAccess();
    await vault.unlock({});
    await vault.setSecret(ROOT_PASSWORD_VAULT_KEY, password);
    errout.write(`[hdc] gitlab install: saved vault ${ROOT_PASSWORD_VAULT_KEY}.\n`);
  } catch (e) {
    errout.write(
      `[hdc] gitlab install: vault save failed: ${String(/** @type {Error} */ (e).message || e)}\n`,
    );
  }
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
 * @param {Record<string, unknown>} gitlab
 * @param {Record<string, unknown>} install
 */
export async function installGitlabInCt(user, pveHost, vmid, gitlab, install) {
  errout.write(`[hdc] gitlab install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "gitlab install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const composeYaml = renderComposeYaml(gitlab);
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

  const port =
    typeof gitlab.host_port === "number" ? gitlab.host_port : Number(gitlab.host_port) || 80;
  const healthy = await waitForGitlabHealth(user, pveHost, vmid, port);
  if (!healthy) {
    return {
      ok: false,
      method: "docker-compose",
      message: "GitLab health check timed out — Omnibus may still be starting; check CT logs",
    };
  }

  const rootPassword = readInitialRootPassword(user, pveHost, vmid);
  if (rootPassword) {
    errout.write(
      `[hdc] gitlab install: initial root password retrieved from container (not logged). Sign in at ${resolveWebUrl(gitlab)} as root.\n`,
    );
    await maybeSaveRootPasswordToVault(rootPassword);
  } else {
    errout.write(
      `[hdc] gitlab install: no initial_root_password file (redeploy?) — use existing root credentials.\n`,
    );
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  errout.write(`[hdc] gitlab install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    web_url: resolveWebUrl(gitlab),
    upstream_url: resolveUpstreamUrl(ip, gitlab),
    ssh_clone_hint: resolveSshCloneHint(ip, gitlab),
    initial_root_password_available: Boolean(rootPassword),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} gitlab
 * @param {Record<string, unknown>} install
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainGitlabInCt(user, pveHost, vmid, gitlab, install, opts = {}) {
  errout.write(`[hdc] gitlab maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "gitlab maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const composeYaml = renderComposeYaml(gitlab);
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, composeYaml, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    web_url: resolveWebUrl(gitlab),
    upstream_url: resolveUpstreamUrl(ip, gitlab),
    ssh_clone_hint: resolveSshCloneHint(ip, gitlab),
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
