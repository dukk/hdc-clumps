import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  composeDir,
  isArgon2PhcAdminToken,
  renderComposeYaml,
  renderVaultwardenEnv,
  resolveAdminUrl,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./vaultwarden-render.mjs";

export { resolvePveSshForHost };

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
 * Shell script (stdout = Argon2 PHC) to hash a plain admin password with Bitwarden defaults.
 * @param {string} plainTokenB64 base64-encoded UTF-8 password
 */
export function buildHashAdminTokenScript(plainTokenB64) {
  const b64 = plainTokenB64.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "command -v argon2 >/dev/null 2>&1 || apt-get install -y -qq argon2 openssl",
    `PLAIN=$(echo '${b64}' | base64 -d)`,
    'echo -n "$PLAIN" | argon2 "$(openssl rand -base64 32)" -e -id -k 65540 -t 3 -p 4',
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} plainToken
 */
export function hashAdminTokenInCt(user, pveHost, vmid, plainToken) {
  const b64 = Buffer.from(plainToken, "utf8").toString("base64");
  const inner = buildHashAdminTokenScript(b64);
  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(`admin token Argon2 hash failed: ${detail.split("\n")[0]}`);
  }
  const hash = r.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!isArgon2PhcAdminToken(hash)) {
    throw new Error("admin token Argon2 hash failed: unexpected output");
  }
  return hash;
}

/**
 * Vault stores the plain admin password; ADMIN_TOKEN in .env must be an Argon2 PHC string.
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} adminToken plain password or existing PHC hash
 */
export function resolveAdminTokenForEnv(user, pveHost, vmid, adminToken) {
  const token = String(adminToken).trim();
  if (!token) throw new Error("admin token required");
  if (isArgon2PhcAdminToken(token)) {
    errout.write("[hdc] vaultwarden: admin token already Argon2 PHC\n");
    return token;
  }
  errout.write("[hdc] vaultwarden: hashing plain admin token to Argon2 PHC …\n");
  return hashAdminTokenInCt(user, pveHost, vmid, token);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} vaultwarden
 * @param {Record<string, unknown>} install
 * @param {string} adminToken
 */
export async function installVaultwardenInCt(user, pveHost, vmid, vaultwarden, install, adminToken) {
  errout.write(`[hdc] vaultwarden install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "vaultwarden install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const adminTokenEnv = resolveAdminTokenForEnv(user, pveHost, vmid, adminToken);
  const envContent = renderVaultwardenEnv(vaultwarden, adminTokenEnv);
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

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  errout.write(`[hdc] vaultwarden install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    web_url: resolveWebUrl(vaultwarden),
    admin_url: resolveAdminUrl(vaultwarden),
    upstream_url: resolveUpstreamUrl(ip, vaultwarden),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} vaultwarden
 * @param {Record<string, unknown>} install
 * @param {string} adminToken
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainVaultwardenInCt(user, pveHost, vmid, vaultwarden, install, adminToken, opts = {}) {
  errout.write(`[hdc] vaultwarden maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "vaultwarden maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const adminTokenEnv = resolveAdminTokenForEnv(user, pveHost, vmid, adminToken);
  const envContent = renderVaultwardenEnv(vaultwarden, adminTokenEnv);
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, envContent, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    web_url: resolveWebUrl(vaultwarden),
    admin_url: resolveAdminUrl(vaultwarden),
    upstream_url: resolveUpstreamUrl(ip, vaultwarden),
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
