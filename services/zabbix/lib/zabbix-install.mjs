import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { zabbixWebHttpPort } from "./deployments.mjs";
import {
  buildComposeDownScript,
  buildMaintainScript,
  buildOfficialStackInstallScript,
  composeDir,
  resolveWebUrl,
  zabbixComposeFile,
  zabbixRelease,
  zabbixStackDir,
} from "./zabbix-render.mjs";

export { resolvePveSshForHost };

/**
 * @typedef {{ run: (script: string) => { status: number; stdout: string; stderr: string }; label?: string }} GuestExec
 */

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {Record<string, unknown>} zabbix
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {string} dbRootPassword
 */
export function buildInstallScript(zabbix, install, dbPassword, dbRootPassword) {
  const release = zabbixRelease(zabbix);
  const composeFile = zabbixComposeFile(zabbix);
  const root = composeDir(install).replace(/'/g, `'\\''`);
  return buildOfficialStackInstallScript(release, composeFile, zabbix, dbPassword, dbRootPassword).replace(
    `export ZABBIX_ROOT='${composeDir({}).replace(/'/g, `'\\''`)}'`,
    `export ZABBIX_ROOT='${root}'`,
  );
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
 * @param {Record<string, unknown>} zabbix
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {string} dbRootPassword
 */
export async function installZabbixInCt(user, pveHost, vmid, zabbix, install, dbPassword, dbRootPassword) {
  errout.write(`[hdc] zabbix install: Docker Compose in CT ${vmid} ...\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, "zabbix install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }
  const inner = buildInstallScript(zabbix, install, dbPassword, dbRootPassword);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, method: "docker-compose", message: `install failed (exit ${r.status})` };
  }
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  return { ok: true, method: "docker-compose", message: "installed", web_url: resolveWebUrl(zabbix, ip) };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} zabbix
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {string} dbRootPassword
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainZabbixInCt(
  user,
  pveHost,
  vmid,
  zabbix,
  install,
  dbPassword,
  dbRootPassword,
  opts = {},
) {
  errout.write(`[hdc] zabbix maintain: refreshing stack in CT ${vmid} ...\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, "zabbix maintain");
  if (!ready) return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  const inner = buildMaintainScript(install, zabbix, dbPassword, dbRootPassword, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) return { ok: false, message: `maintain failed (exit ${r.status})` };
  return { ok: true, message: opts.skipUpgrade ? "restarted" : "images refreshed" };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} zabbix
 */
export function composeDownInCt(user, pveHost, vmid, install, zabbix) {
  const inner = buildComposeDownScript(install, zabbix);
  pctExec(user, pveHost, vmid, inner);
}

/**
 * @param {GuestExec} exec
 * @param {Record<string, unknown>} zabbix
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {string} dbRootPassword
 */
export async function installZabbixOnHost(exec, zabbix, install, dbPassword, dbRootPassword) {
  errout.write(`[hdc] zabbix install: Docker Compose via ${exec.label ?? "ssh"} …\n`);
  const inner = buildInstallScript(zabbix, install, dbPassword, dbRootPassword);
  const r = exec.run(inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
      detail: `${r.stderr}${r.stdout}`.trim() || null,
    };
  }
  const ipOut = exec.run("hostname -I | awk '{print $1}'");
  const ip = ipOut.status === 0 ? ipOut.stdout.trim().split(/\s+/)[0] || null : null;
  return { ok: true, method: "docker-compose", message: "installed", web_url: resolveWebUrl(zabbix, ip) };
}

/**
 * @param {GuestExec} exec
 * @param {Record<string, unknown>} zabbix
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {string} dbRootPassword
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainZabbixOnHost(exec, zabbix, install, dbPassword, dbRootPassword, opts = {}) {
  errout.write(`[hdc] zabbix maintain: refreshing stack via ${exec.label ?? "ssh"} …\n`);
  const inner = buildMaintainScript(install, zabbix, dbPassword, dbRootPassword, opts);
  const r = exec.run(inner);
  if (r.status !== 0) return { ok: false, message: `maintain failed (exit ${r.status})` };
  return { ok: true, message: opts.skipUpgrade ? "restarted" : "images refreshed" };
}

/**
 * @param {GuestExec} exec
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} zabbix
 */
export function composeDownOnHost(exec, install, zabbix) {
  const inner = buildComposeDownScript(install, zabbix);
  exec.run(inner);
}

/**
 * @param {GuestExec} exec
 * @param {Record<string, unknown>} zabbix
 * @param {Record<string, unknown>} install
 * @param {number | null} [vmid]
 */
export function queryZabbixOnHost(exec, zabbix, install, vmid = null) {
  const dir = zabbixStackDir(install);
  const composeFile = zabbixComposeFile(zabbix);
  const webPort = zabbixWebHttpPort(zabbix);
  const cap = { capture: true };
  const docker = exec.run("systemctl is-active docker 2>/dev/null || echo inactive", cap);
  const composePs = exec.run(
    `test -d ${shellQuote(dir)} && cd ${shellQuote(dir)} && docker compose -f ${shellQuote(composeFile)} ps --format json 2>/dev/null || docker compose -f ${shellQuote(composeFile)} ps 2>/dev/null || echo '[]'`,
    cap,
  );
  const ipOut = exec.run("hostname -I | awk '{print $1}'", cap);
  const ip = ipOut.status === 0 ? ipOut.stdout.trim().split(/\s+/)[0] || null : null;
  const health = exec.run(
    `curl -sf --max-time 8 http://127.0.0.1:${webPort}/ -o /dev/null && echo ok || echo fail`,
    cap,
  );
  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    guest_ip: ip,
    ct_ip: ip,
    web_http_port: webPort,
    web_url: resolveWebUrl(zabbix, ip),
    web_ok: health.stdout.trim() === "ok",
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} zabbix
 * @param {Record<string, unknown>} install
 */
export function queryZabbixInCt(user, pveHost, vmid, zabbix, install) {
  const dir = zabbixStackDir(install);
  const composeFile = zabbixComposeFile(zabbix);
  const webPort = zabbixWebHttpPort(zabbix);
  const docker = pctExec(user, pveHost, vmid, "systemctl is-active docker 2>/dev/null || echo inactive", {
    capture: true,
  });
  const composePs = pctExec(
    user,
    pveHost,
    vmid,
    `test -d ${shellQuote(dir)} && cd ${shellQuote(dir)} && docker compose -f ${shellQuote(composeFile)} ps --format json 2>/dev/null || docker compose -f ${shellQuote(composeFile)} ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const health = pctExec(
    user,
    pveHost,
    vmid,
    `curl -sf --max-time 8 http://127.0.0.1:${webPort}/ -o /dev/null && echo ok || echo fail`,
    { capture: true },
  );
  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ip,
    guest_ip: ip,
    web_http_port: webPort,
    web_url: resolveWebUrl(zabbix, ip),
    web_ok: health.stdout.trim() === "ok",
  };
}
