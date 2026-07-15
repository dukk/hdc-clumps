import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { renderLitellmConfigYaml } from "./litellm-config-render.mjs";
import {
  composeDir,
  renderComposeYaml,
  renderLitellmEnv,
  resolveApiUrl,
  resolveUiUrl,
  resolveUpstreamUrl,
} from "./litellm-render.mjs";

export { resolvePveSshForHost };

/**
 * Parse OPENROUTER_API_KEY from a guest `.env` file body (value only; never log it).
 * @param {string} envText
 * @returns {string | null}
 */
export function parseOpenrouterApiKeyFromEnvText(envText) {
  const text = typeof envText === "string" ? envText : "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^OPENROUTER_API_KEY\s*=\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    let value = m[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} composeDirPath
 * @returns {string | null}
 */
function readGuestOpenrouterApiKey(user, pveHost, vmid, composeDirPath) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const r = pctExec(user, pveHost, vmid, `test -f '${dir}/.env' && cat '${dir}/.env' || true`, {
    capture: true,
  });
  if (r.status !== 0) return null;
  return parseOpenrouterApiKeyFromEnvText(r.stdout || "");
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {string} configYaml
 */
export function buildInstallScript(composeDirPath, composeYaml, envContent, configYaml) {
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
    `cat > '${dir}/config.yaml' <<'HDCCONFIG'`,
    configYaml.trimEnd(),
    "HDCCONFIG",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    `chmod 600 '${dir}/.env' '${dir}/config.yaml'`,
    `cd '${dir}'`,
    "docker compose pull",
    "docker compose up -d",
    "docker compose ps",
  ].join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} envContent
 * @param {string} configYaml
 * @param {{ skipUpgrade?: boolean; resetVolumes?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, envContent, configYaml, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}'`,
    `test -f '${dir}/docker-compose.yml'`,
    `cat > '${dir}/config.yaml' <<'HDCCONFIG'`,
    configYaml.trimEnd(),
    "HDCCONFIG",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    `chmod 600 '${dir}/.env' '${dir}/config.yaml'`,
    `cd '${dir}'`,
  ];
  if (opts.resetVolumes) {
    lines.push("docker compose down -v || true");
  }
  if (!opts.skipUpgrade) {
    lines.push("docker compose pull");
  }
  lines.push("docker compose up -d", "docker compose ps");
  return lines.join("\n");
}

/**
 * After .env matches vault, ALTER the Postgres role to the vault password and recreate litellm.
 * Uses local socket auth inside litellm-db. Does not print the password.
 * @param {string} composeDirPath
 */
export function buildAlignDbPasswordScript(composeDirPath) {
  const dirJson = JSON.stringify(composeDirPath);
  const envPathJson = JSON.stringify(`${composeDirPath}/.env`.replace(/\\/g, "/"));
  const composePathJson = JSON.stringify(`${composeDirPath}/docker-compose.yml`.replace(/\\/g, "/"));
  return [
    "set -euo pipefail",
    `test -f ${envPathJson}`,
    `test -f ${composePathJson}`,
    "python3 - <<'PY'",
    "import subprocess, sys",
    "from pathlib import Path",
    `dir_path = Path(${dirJson})`,
    "file_env = {}",
    "for line in (dir_path / '.env').read_text().splitlines():",
    "    if '=' in line and not line.startswith('#'):",
    "        k, v = line.split('=', 1)",
    "        file_env[k] = v",
    "pw = file_env.get('LITELLM_DB_PASSWORD') or ''",
    "if not pw:",
    "    print('LITELLM_DB_PASSWORD missing from .env', file=sys.stderr)",
    "    sys.exit(1)",
    "sql = \"ALTER USER llmproxy WITH PASSWORD '\" + pw.replace(\"'\", \"''\") + \"';\"",
    "r = subprocess.run(",
    "    ['docker', 'exec', '-i', 'litellm-db', 'psql', '-U', 'llmproxy', '-d', 'litellm', '-v', 'ON_ERROR_STOP=1'],",
    "    input=sql,",
    "    text=True,",
    "    capture_output=True,",
    ")",
    "if r.returncode != 0:",
    "    print((r.stderr or r.stdout or 'alter failed')[:500], file=sys.stderr)",
    "    sys.exit(r.returncode or 1)",
    "print('altered llmproxy password to match LITELLM_DB_PASSWORD')",
    "PY",
    `cd ${dirJson}`,
    "docker compose up -d --force-recreate litellm",
    "docker compose ps",
  ].join("\n");
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
 * @param {Record<string, unknown>} litellm
 * @param {{ masterKey: string; saltKey: string; dbPassword: string; openrouterApiKey?: string | null }} secrets
 */
function renderStackFiles(litellm, secrets) {
  const envContent = renderLitellmEnv(litellm, secrets);
  const configYaml = renderLitellmConfigYaml(litellm);
  const composeYaml = renderComposeYaml();
  return { envContent, configYaml, composeYaml };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} litellm
 * @param {Record<string, unknown>} install
 * @param {{ masterKey: string; saltKey: string; dbPassword: string; openrouterApiKey?: string | null }} secrets
 */
export async function installLitellmInCt(user, pveHost, vmid, litellm, install, secrets) {
  errout.write(`[hdc] litellm install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "litellm install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const { envContent, configYaml, composeYaml } = renderStackFiles(litellm, secrets);
  const dir = composeDir(install);
  const inner = buildInstallScript(dir, composeYaml, envContent, configYaml);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  errout.write(`[hdc] litellm install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    api_url: resolveApiUrl(litellm, ip),
    ui_url: resolveUiUrl(litellm, ip),
    upstream_url: resolveUpstreamUrl(ip, litellm),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} litellm
 * @param {Record<string, unknown>} install
 * @param {{ masterKey: string; saltKey: string; dbPassword: string; openrouterApiKey?: string | null }} secrets
 * @param {{ skipUpgrade?: boolean; resetDb?: boolean; alignDbPassword?: boolean }} [opts]
 */
export async function maintainLitellmInCt(user, pveHost, vmid, litellm, install, secrets, opts = {}) {
  const resetVolumes = opts.resetDb === true;
  const alignDb = opts.alignDbPassword === true && !resetVolumes;
  errout.write(`[hdc] litellm maintain: refreshing stack in CT ${vmid} …\n`);
  if (resetVolumes) {
    errout.write(
      "[hdc] litellm maintain: WARNING — destroying Docker volumes (postgres_data); spend/keys DB will be wiped …\n",
    );
  }
  if (alignDb) {
    errout.write(
      "[hdc] litellm maintain: aligning Postgres llmproxy password to vault LITELLM_DB_PASSWORD …\n",
    );
  }

  const ready = await waitForCt(user, pveHost, vmid, 2000, "litellm maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const dir = composeDir(install);
  /** @type {{ masterKey: string; saltKey: string; dbPassword: string; openrouterApiKey?: string | null }} */
  const effectiveSecrets = { ...secrets };
  const vaultOpenrouter =
    typeof secrets.openrouterApiKey === "string" ? secrets.openrouterApiKey.trim() : "";
  if (!vaultOpenrouter) {
    const guestKey = readGuestOpenrouterApiKey(user, pveHost, vmid, dir);
    if (guestKey) {
      effectiveSecrets.openrouterApiKey = guestKey;
      errout.write(
        `[hdc] litellm maintain: preserved OPENROUTER_API_KEY from guest ${dir}/.env (vault key empty)\n`,
      );
    }
  }
  const { envContent, configYaml } = renderStackFiles(litellm, effectiveSecrets);
  const inner = buildMaintainScript(dir, envContent, configYaml, {
    skipUpgrade: opts.skipUpgrade,
    resetVolumes,
  });
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }

  if (alignDb) {
    const align = pctExec(user, pveHost, vmid, buildAlignDbPasswordScript(dir));
    if (align.status !== 0) {
      return {
        ok: false,
        message: `align-db-password failed (exit ${align.status})`,
        db_password_aligned: false,
        db_volume_reset: resetVolumes,
      };
    }
  }

  /** @type {string} */
  let message = opts.skipUpgrade ? "restarted" : "images refreshed";
  if (resetVolumes) message = "db volumes reset; stack recreated";
  else if (alignDb) message = "db password aligned; litellm recreated";

  return {
    ok: true,
    message,
    db_volume_reset: resetVolumes,
    db_password_aligned: alignDb,
    api_url: resolveApiUrl(litellm, ip),
    ui_url: resolveUiUrl(litellm, ip),
    upstream_url: resolveUpstreamUrl(ip, litellm),
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
