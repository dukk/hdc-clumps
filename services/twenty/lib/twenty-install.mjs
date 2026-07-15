import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  composeDir,
  renderComposeYaml,
  renderTwentyEnv,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./twenty-render.mjs";
import { twentyEncryptionKeyId } from "./encryption-key-id.mjs";
import {
  buildEncryptionKeyGuardLines,
  buildSigningKeyLogHealLines,
} from "./twenty-signing-key-heal.mjs";

export { resolvePveSshForHost };

/**
 * Reconcile Postgres role password from `.env` when the data volume is already initialized.
 * Skips empty/fresh volumes so first-boot init keeps POSTGRES_PASSWORD from compose.
 * @returns {string[]}
 */
export function buildPostgresPasswordSyncLines() {
  return [
    "if docker compose exec -T db test -f /var/lib/postgresql/data/PG_VERSION 2>/dev/null; then",
    '  PW="$(grep -E "^PG_DATABASE_PASSWORD=" .env | head -1 | cut -d= -f2- | tr -d \'\\r"\' || true)"',
    '  if [ -n "${PW}" ]; then',
    `    docker compose exec -T db psql -U postgres -d postgres -c "ALTER USER \${DB_USER} PASSWORD '\${PW}';"`,
    '    docker compose exec -T -e PGPASSWORD="$PW" db psql -U "${DB_USER}" -h localhost -d postgres -c "SELECT 1"',
    "  fi",
    "fi",
  ];
}

/**
 * Staged compose startup: db/redis first, then server (with /healthz poll), then worker.
 * Avoids compose aborting when server migrations exceed the default healthcheck window.
 * @param {string} dir Shell-safe compose directory path.
 * @param {{ chdir?: boolean; pull?: boolean; encryptionKeyId?: string }} [opts]
 */
export function buildStagedComposeUpLines(dir, opts = {}) {
  /** @type {string[]} */
  const lines = [];
  if (opts.chdir !== false) {
    lines.push(`cd '${dir}'`);
  }
  if (opts.pull) {
    lines.push("docker compose pull");
  }
  lines.push(
    "HOST_PORT=\"$(grep -E '^TWENTY_HOST_PORT=' .env | head -1 | cut -d= -f2- | tr -d '\\r\"' || true)\"",
    'HOST_PORT="${HOST_PORT:-3000}"',
    "DB_USER=\"$(grep -E '^PG_DATABASE_USER=' .env | head -1 | cut -d= -f2- | tr -d '\\r\"' || true)\"",
    'DB_USER="${DB_USER:-postgres}"',
    "docker compose up -d db redis",
    "for i in $(seq 1 60); do",
    '  docker compose exec -T db pg_isready -U "${DB_USER}" -h localhost -d postgres >/dev/null 2>&1 && break',
    "  sleep 2",
    "done",
    ...buildPostgresPasswordSyncLines(),
    ...(opts.encryptionKeyId ? buildEncryptionKeyGuardLines(dir, opts.encryptionKeyId) : []),
    "for i in $(seq 1 30); do",
    "  docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG && break",
    "  sleep 2",
    "done",
    "docker compose up -d --no-deps server",
    "for i in $(seq 1 60); do",
    "  curl -sf --max-time 5 \"http://127.0.0.1:${HOST_PORT}/healthz\" >/dev/null 2>&1 && break",
    "  sleep 5",
    "done",
    "docker compose up -d --no-deps worker",
    "docker compose ps",
    ...buildSigningKeyLogHealLines(),
    "curl -sf --max-time 10 \"http://127.0.0.1:${HOST_PORT}/healthz\" >/dev/null",
  );
  return lines;
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 */
export function buildInstallScript(composeDirPath, composeYaml, envContent, encryptionKeyId) {
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
    ...buildStagedComposeUpLines(dir, { pull: true, encryptionKeyId }),
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
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    `cd '${dir}'`,
  ];
  lines.push(
    ...buildStagedComposeUpLines(dir, {
      chdir: false,
      pull: !opts.skipUpgrade,
      encryptionKeyId: opts.encryptionKeyId,
    }),
  );
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
 * @param {Record<string, unknown>} twenty
 * @param {Record<string, unknown>} install
 * @param {{ encryptionKey: string; dbPassword: string; fallbackEncryptionKey?: string | null }} secrets
 */
export async function installTwentyInCt(user, pveHost, vmid, twenty, install, secrets) {
  errout.write(`[hdc] twenty install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "twenty install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const envContent = renderTwentyEnv(twenty, secrets, ip);
  const composeYaml = renderComposeYaml();
  const dir = composeDir(install);
  const inner = buildInstallScript(dir, composeYaml, envContent, twentyEncryptionKeyId(secrets.encryptionKey));

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  errout.write(
    `[hdc] twenty install: completed on CT ${vmid}. Allow 1–2 minutes for migrations; verify /healthz before first login.\n`,
  );
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    url: resolveWebUrl(twenty, ip),
    upstream_url: resolveUpstreamUrl(ip, twenty),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} twenty
 * @param {Record<string, unknown>} install
 * @param {{ encryptionKey: string; dbPassword: string; fallbackEncryptionKey?: string | null }} secrets
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainTwentyInCt(user, pveHost, vmid, twenty, install, secrets, opts = {}) {
  errout.write(`[hdc] twenty maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "twenty maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const envContent = renderTwentyEnv(twenty, secrets, ip);
  const composeYaml = renderComposeYaml();
  const dir = composeDir(install);
  const inner = buildMaintainScript(dir, composeYaml, envContent, {
    ...opts,
    encryptionKeyId: twentyEncryptionKeyId(secrets.encryptionKey),
  });
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    url: resolveWebUrl(twenty, ip),
    upstream_url: resolveUpstreamUrl(ip, twenty),
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

/**
 * @param {ReturnType<typeof import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} exec
 * @param {Record<string, unknown>} twenty
 * @param {Record<string, unknown>} install
 * @param {{ encryptionKey: string; dbPassword: string; fallbackEncryptionKey?: string | null }} secrets
 * @param {string | null} guestIp
 * @param {{ maintain?: boolean; skipUpgrade?: boolean }} [opts]
 */
async function runTwentyStackOnGuest(exec, twenty, install, secrets, guestIp, opts = {}) {
  const envContent = renderTwentyEnv(twenty, secrets, guestIp);
  const composeYaml = renderComposeYaml();
  const dir = composeDir(install);
  const encryptionKeyId = twentyEncryptionKeyId(secrets.encryptionKey);
  const inner = opts.maintain
    ? buildMaintainScript(dir, composeYaml, envContent, {
        skipUpgrade: opts.skipUpgrade,
        encryptionKeyId,
      })
    : buildInstallScript(dir, composeYaml, envContent, encryptionKeyId);

  const r = exec.run(inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, method: "docker-compose", message: detail };
  }

  return {
    ok: true,
    method: "docker-compose",
    message: opts.maintain ? (opts.skipUpgrade ? "restarted" : "images refreshed") : "installed",
    url: resolveWebUrl(twenty, guestIp),
    upstream_url: resolveUpstreamUrl(guestIp, twenty),
    guest_ip: guestIp,
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} opts.exec
 * @param {Record<string, unknown>} opts.twenty
 * @param {Record<string, unknown>} opts.install
 * @param {{ encryptionKey: string; dbPassword: string }} opts.secrets
 * @param {string | null} [opts.guestIp]
 */
export async function installTwentyInQemu(opts) {
  const { exec, twenty, install, secrets, guestIp = null } = opts;
  errout.write(`[hdc] twenty install: Docker Compose on ${exec.label} …\n`);

  const result = await runTwentyStackOnGuest(exec, twenty, install, secrets, guestIp);
  if (!result.ok) return result;

  errout.write(
    `[hdc] twenty install: completed on ${exec.label}. Allow 1–2 minutes for migrations; verify /healthz before first login.\n`,
  );
  return result;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} opts.exec
 * @param {Record<string, unknown>} opts.twenty
 * @param {Record<string, unknown>} opts.install
 * @param {{ encryptionKey: string; dbPassword: string }} opts.secrets
 * @param {{ skipUpgrade?: boolean }} [opts.maintainOpts]
 */
export async function maintainTwentyInQemu(opts) {
  const { exec, twenty, install, secrets, maintainOpts = {} } = opts;
  errout.write(`[hdc] twenty maintain: refreshing stack on ${exec.label} …\n`);

  const result = await runTwentyStackOnGuest(exec, twenty, install, secrets, null, {
    maintain: true,
    skipUpgrade: maintainOpts.skipUpgrade,
  });
  if (!result.ok) {
    return { ok: false, message: result.message || "maintain failed" };
  }
  return result;
}

/**
 * @param {ReturnType<typeof import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} exec
 * @param {Record<string, unknown>} install
 */
export function composeDownOnGuest(exec, install) {
  const dir = composeDir(install);
  const inner = buildComposeDownScript(dir);
  exec.run(inner, { capture: true });
}
