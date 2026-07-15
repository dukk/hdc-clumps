import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { parseResetAdminOutput } from "./safeline-admin-setup.mjs";
import {
  adminPasswordVaultKey,
  composeDir,
  mgtPort,
  renderSafelineEnv,
  resolveMgtUrl,
  resolveWebUrl,
} from "./safeline-render.mjs";
import { storeAdminPassword } from "./vault-secrets.mjs";

export { resolvePveSshForHost };

const here = dirname(fileURLToPath(import.meta.url));
const bundledCompose = readFileSync(join(here, "..", "assets", "compose.yaml"), "utf8");

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
    `mkdir -p '${dir}/resources/postgres/data' '${dir}/resources/mgt' '${dir}/logs/nginx' '${dir}/resources/sock' '${dir}/resources/detector' '${dir}/logs/detector' '${dir}/resources/nginx' '${dir}/resources/chaos' '${dir}/resources/cache' '${dir}/resources/luigi'`,
    `cat > '${dir}/compose.yaml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    `cd '${dir}'`,
    "docker compose -f compose.yaml pull",
    "docker compose -f compose.yaml up -d",
    "docker compose -f compose.yaml ps",
  ].join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, composeYaml, envContent, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}'`,
    `cat > '${dir}/compose.yaml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    `cd '${dir}'`,
  ];
  if (!opts.skipUpgrade) lines.push("docker compose -f compose.yaml pull");
  lines.push("docker compose -f compose.yaml up -d", "docker compose -f compose.yaml ps");
  return lines.join("\n");
}

/**
 * @param {string} composeDirPath
 */
export function buildComposeDownScript(composeDirPath) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `if test -f '${dir}/compose.yaml'; then`,
    `  cd '${dir}' && docker compose -f compose.yaml down -v 2>/dev/null || true`,
    "fi",
  ].join("\n");
}

/**
 * @param {number} port
 * @param {number} [timeoutMs]
 */
export function buildWaitHealthScript(port, timeoutMs = 600000) {
  const deadline = Math.max(60, Math.floor(timeoutMs / 1000));
  return [
    "set -euo pipefail",
    `port=${port}`,
    `deadline=$(( $(date +%s) + ${deadline} ))`,
    "while [ \"$(date +%s)\" -lt \"$deadline\" ]; do",
    "  if curl -skf --max-time 5 \"https://127.0.0.1:${port}/api/open/health\" -o /dev/null; then",
    "    exit 0",
    "  fi",
    "  sleep 5",
    "done",
    "echo 'SafeLine management API did not become ready in time' >&2",
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
 * @param {ReturnType<import("./vault-deps.mjs").createSafelineVaultAccess>} vault
 * @param {Record<string, unknown>} safeline
 */
export async function resetAdminInCt(user, pveHost, vmid, vault, safeline) {
  errout.write(`[hdc] safeline install: resetting admin credentials in CT ${vmid} …\n`);
  const r = pctExec(user, pveHost, vmid, "docker exec safeline-mgt resetadmin 2>&1", { capture: true });
  const output = `${r.stdout}${r.stderr}`.trim();
  if (r.status !== 0) {
    return { ok: false, message: `resetadmin failed (exit ${r.status})` };
  }

  const parsed = parseResetAdminOutput(output);
  if (!parsed) {
    return { ok: false, message: "resetadmin output missing Initial password" };
  }

  const vaultKey = adminPasswordVaultKey(safeline);
  try {
    await storeAdminPassword(vault, safeline, parsed.password);
  } catch (e) {
    return {
      ok: false,
      message: `failed to store admin password in vault ${vaultKey}: ${String(/** @type {Error} */ (e).message || e)}`,
    };
  }

  errout.write(
    `[hdc] safeline install: admin reset completed — username ${parsed.username}; password in vault ${vaultKey}.\n`,
  );
  return {
    ok: true,
    message: "admin reset",
    username: parsed.username,
    vault_key: vaultKey,
    password_stored: true,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} safeline
 * @param {Record<string, unknown>} install
 * @param {string} postgresPassword
 * @param {{ adminReset?: boolean; vault?: ReturnType<import("./vault-deps.mjs").createSafelineVaultAccess> }} [opts]
 */
export async function installSafelineInCt(user, pveHost, vmid, safeline, install, postgresPassword, opts = {}) {
  errout.write(`[hdc] safeline install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "safeline install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const envContent = renderSafelineEnv(safeline, postgresPassword, install);
  const dir = composeDir(install);
  const inner = buildInstallScript(dir, bundledCompose, envContent);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, method: "docker-compose", message: `install failed (exit ${r.status})` };
  }

  const port = mgtPort(safeline);
  const wait = pctExec(user, pveHost, vmid, buildWaitHealthScript(port));
  if (wait.status !== 0) {
    return { ok: false, method: "docker-compose", message: "management API health check timed out" };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  /** @type {Awaited<ReturnType<typeof resetAdminInCt>> | null} */
  let adminReset = null;
  if (opts.adminReset === true) {
    if (!opts.vault) {
      return {
        ok: false,
        method: "docker-compose",
        message: "admin reset requires vault access",
        ct_ip: ip,
      };
    }
    adminReset = await resetAdminInCt(user, pveHost, vmid, opts.vault, safeline);
    if (!adminReset.ok) {
      return {
        ok: false,
        method: "docker-compose",
        message: adminReset.message || "admin reset failed",
        ct_ip: ip,
      };
    }
  }

  errout.write(`[hdc] safeline install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    url: resolveWebUrl(ip, safeline),
    mgt_url: resolveMgtUrl(ip, safeline),
    ct_ip: ip,
    admin_reset: adminReset,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} safeline
 * @param {Record<string, unknown>} install
 * @param {string} postgresPassword
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainSafelineInCt(user, pveHost, vmid, safeline, install, postgresPassword, opts = {}) {
  errout.write(`[hdc] safeline maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "safeline maintain");
  if (!ready) return { ok: false, message: `CT ${vmid} not reachable via pct exec` };

  const envContent = renderSafelineEnv(safeline, postgresPassword, install);
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, bundledCompose, envContent, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) return { ok: false, message: `maintain failed (exit ${r.status})` };

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    url: resolveWebUrl(ip, safeline),
    mgt_url: resolveMgtUrl(ip, safeline),
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
  pctExec(user, pveHost, vmid, buildComposeDownScript(dir));
}
