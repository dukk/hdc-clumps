import { stderr as errout } from "node:process";

import { growRootFilesystemScript } from "hdc/package/qemu-rootfs-resize.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  composeDir,
  normalizePostgresImageTag,
  renderComposeYaml,
  renderDotEnv,
  renderPaperlessEnv,
  resolveUpstreamUrl,
  resolveWebUrl,
  tikaEnabled,
  usermapGid,
  usermapUid,
} from "./paperless-ngx-render.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} composeDirPath
 * @param {number} uid
 * @param {number} gid
 */
function mkdirDataDirsScript(composeDirPath, uid, gid) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  return [
    `mkdir -p '${dir}/consume' '${dir}/export'`,
    `chown ${uid}:${gid} '${dir}/consume' '${dir}/export'`,
  ].join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} dotEnv
 * @param {string} paperlessEnv
 * @param {number} uid
 * @param {number} gid
 */
export function buildInstallScript(composeDirPath, composeYaml, dotEnv, paperlessEnv, uid, gid) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);

  return [
    growRootFilesystemScript(),
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq ca-certificates curl gnupg",
    "if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then",
    "  install -m 0755 -d /etc/apt/keyrings",
    "  if [ ! -f /etc/apt/keyrings/docker.asc ]; then",
    "    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "    chmod a+r /etc/apt/keyrings/docker.asc",
    '    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME:-$VERSION_ID}) stable" > /etc/apt/sources.list.d/docker.list',
    "  fi",
    "  apt-get update -qq",
    "  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin",
    "fi",
    "systemctl enable --now docker",
    `mkdir -p '${dir}'`,
    mkdirDataDirsScript(dir, uid, gid),
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    dotEnv.trimEnd(),
    "HDCENV",
    `cat > '${dir}/paperless.env' <<'HDPAPERLESS'`,
    paperlessEnv.trimEnd(),
    "HDPAPERLESS",
    `cd '${dir}'`,
    "docker compose pull",
    "docker compose up -d",
    "docker compose ps",
  ].join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} composeYaml
 * @param {string} dotEnv
 * @param {string} paperlessEnv
 * @param {number} uid
 * @param {number} gid
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(
  composeDirPath,
  composeYaml,
  dotEnv,
  paperlessEnv,
  uid,
  gid,
  opts = {},
) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}'`,
    mkdirDataDirsScript(dir, uid, gid),
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    dotEnv.trimEnd(),
    "HDCENV",
    `cat > '${dir}/paperless.env' <<'HDPAPERLESS'`,
    paperlessEnv.trimEnd(),
    "HDPAPERLESS",
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
 * @param {Record<string, unknown>} paperless
 * @param {{ secretKey: string; dbPassword: string; adminPassword?: string | null }} secrets
 * @param {string | null} ctIp
 */
function renderStackFiles(paperless, secrets, ctIp) {
  const withTika = tikaEnabled(paperless);
  const composeYaml = renderComposeYaml({
    tikaEnabled: withTika,
    postgresImageTag: normalizePostgresImageTag(paperless),
  });
  const dotEnv = renderDotEnv(paperless, secrets);
  const paperlessEnv = renderPaperlessEnv(paperless, secrets, ctIp);
  return { composeYaml, dotEnv, paperlessEnv, withTika };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} paperless
 * @param {Record<string, unknown>} install
 * @param {{ secretKey: string; dbPassword: string; adminPassword?: string | null }} secrets
 */
export async function installPaperlessNgxInCt(user, pveHost, vmid, paperless, install, secrets) {
  errout.write(`[hdc] paperless-ngx install: Docker Compose in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "paperless-ngx install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const { composeYaml, dotEnv, paperlessEnv, withTika } = renderStackFiles(paperless, secrets, ip);
  const dir = composeDir(install);
  const uid = usermapUid(paperless);
  const gid = usermapGid(paperless);
  const inner = buildInstallScript(dir, composeYaml, dotEnv, paperlessEnv, uid, gid);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
    };
  }

  errout.write(`[hdc] paperless-ngx install: completed on CT ${vmid} (tika_enabled=${withTika}).\n`);
  return {
    ok: true,
    method: "docker-compose",
    message: "installed",
    tika_enabled: withTika,
    url: resolveWebUrl(paperless, ip),
    upstream_url: resolveUpstreamUrl(ip, paperless),
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} paperless
 * @param {Record<string, unknown>} install
 * @param {{ secretKey: string; dbPassword: string; adminPassword?: string | null }} secrets
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainPaperlessNgxInCt(
  user,
  pveHost,
  vmid,
  paperless,
  install,
  secrets,
  opts = {},
) {
  errout.write(`[hdc] paperless-ngx maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "paperless-ngx maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const { composeYaml, dotEnv, paperlessEnv, withTika } = renderStackFiles(paperless, secrets, ip);
  const dir = composeDir(install);
  const uid = usermapUid(paperless);
  const gid = usermapGid(paperless);
  const inner = buildMaintainScript(dir, composeYaml, dotEnv, paperlessEnv, uid, gid, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})` };
  }
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    tika_enabled: withTika,
    url: resolveWebUrl(paperless, ip),
    upstream_url: resolveUpstreamUrl(ip, paperless),
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
 * @param {Record<string, unknown>} paperless
 * @param {Record<string, unknown>} install
 * @param {{ secretKey: string; dbPassword: string; adminPassword?: string | null }} secrets
 * @param {string | null} guestIp
 * @param {{ maintain?: boolean; skipUpgrade?: boolean }} [opts]
 */
async function runPaperlessStackOnGuest(exec, paperless, install, secrets, guestIp, opts = {}) {
  const { composeYaml, dotEnv, paperlessEnv, withTika } = renderStackFiles(paperless, secrets, guestIp);
  const dir = composeDir(install);
  const uid = usermapUid(paperless);
  const gid = usermapGid(paperless);
  const inner = opts.maintain
    ? buildMaintainScript(dir, composeYaml, dotEnv, paperlessEnv, uid, gid, {
        skipUpgrade: opts.skipUpgrade,
      })
    : buildInstallScript(dir, composeYaml, dotEnv, paperlessEnv, uid, gid);

  const r = exec.run(inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, method: "docker-compose", message: detail };
  }

  return {
    ok: true,
    method: "docker-compose",
    message: opts.maintain ? (opts.skipUpgrade ? "restarted" : "images refreshed") : "installed",
    tika_enabled: withTika,
    url: resolveWebUrl(paperless, guestIp),
    upstream_url: resolveUpstreamUrl(guestIp, paperless),
    guest_ip: guestIp,
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} opts.exec
 * @param {Record<string, unknown>} opts.paperless
 * @param {Record<string, unknown>} opts.install
 * @param {{ secretKey: string; dbPassword: string; adminPassword?: string | null }} opts.secrets
 * @param {string | null} [opts.guestIp]
 */
export async function installPaperlessNgxInQemu(opts) {
  const { exec, paperless, install, secrets, guestIp = null } = opts;
  errout.write(`[hdc] paperless-ngx install: Docker Compose on ${exec.label} …\n`);

  const result = await runPaperlessStackOnGuest(exec, paperless, install, secrets, guestIp);
  if (!result.ok) return result;

  errout.write(`[hdc] paperless-ngx install: completed on ${exec.label} (tika_enabled=${result.tika_enabled}).\n`);
  return result;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} opts.exec
 * @param {Record<string, unknown>} opts.paperless
 * @param {Record<string, unknown>} opts.install
 * @param {{ secretKey: string; dbPassword: string; adminPassword?: string | null }} opts.secrets
 * @param {{ skipUpgrade?: boolean }} [opts.maintainOpts]
 */
export async function maintainPaperlessNgxInQemu(opts) {
  const { exec, paperless, install, secrets, maintainOpts = {} } = opts;
  errout.write(`[hdc] paperless-ngx maintain: refreshing stack on ${exec.label} …\n`);

  const guestIp = null;
  const result = await runPaperlessStackOnGuest(exec, paperless, install, secrets, guestIp, {
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
