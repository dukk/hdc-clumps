import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import {
  composeDir,
  consolePort,
  parseConsolePublicUrl,
  parseS3PublicUrl,
  s3Port,
} from "./rustfs-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} rustfs
 * @param {Record<string, unknown>} install
 */
export async function queryRustfsInCt(user, pveHost, vmid, rustfs, install) {
  const cfg = isObject(rustfs) ? rustfs : {};
  const s3 = s3Port(cfg);
  const console = consolePort(cfg);
  const dir = composeDir(isObject(install) ? install : {});

  let s3Public = null;
  let consolePublic = null;
  try {
    const parsed = parseS3PublicUrl(cfg);
    s3Public = parsed ? parsed.origin.replace(/\/+$/, "") : null;
  } catch {
    s3Public = null;
  }
  try {
    const parsed = parseConsolePublicUrl(cfg);
    consolePublic = parsed ? parsed.origin.replace(/\/+$/, "") : null;
  } catch {
    consolePublic = null;
  }

  const docker = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active docker 2>/dev/null || echo inactive",
    { capture: true },
  );
  const composePs = pctExec(
    user,
    pveHost,
    vmid,
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  let s3HealthOk = null;
  let consoleHealthOk = null;
  let healthError = null;

  if (docker.stdout.trim() === "active") {
    const s3Cmd = `curl -sf --max-time 5 http://127.0.0.1:${s3}/health -o /dev/null && echo ok || echo fail`;
    const s3h = pctExec(user, pveHost, vmid, s3Cmd, { capture: true });
    s3HealthOk = s3h.status === 0 && s3h.stdout.trim() === "ok";

    const consoleCmd = `curl -sf --max-time 5 http://127.0.0.1:${console}/rustfs/console/health -o /dev/null && echo ok || echo fail`;
    const ch = pctExec(user, pveHost, vmid, consoleCmd, { capture: true });
    consoleHealthOk = ch.status === 0 && ch.stdout.trim() === "ok";

    if (!s3HealthOk || !consoleHealthOk) {
      healthError = [s3h.stderr.trim(), ch.stderr.trim()].filter(Boolean).join("; ") || "health probe failed";
    }
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    s3_public_url: s3Public,
    console_public_url: consolePublic,
    s3_health_ok: s3HealthOk,
    console_health_ok: consoleHealthOk,
    health_error: healthError,
    s3_port: s3,
    console_port: console,
    upstream_s3: ctIp ? `http://${ctIp}:${s3}` : null,
    upstream_console: ctIp ? `http://${ctIp}:${console}` : null,
    s3_url: s3Public || (ctIp ? `http://${ctIp}:${s3}` : null),
    console_url: consolePublic || (ctIp ? `http://${ctIp}:${console}` : null),
  };
}
