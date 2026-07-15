import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { normalizeVersionTag } from "./deployments.mjs";
import {
  readAppUrlFromEnv,
  readCtPrimaryIp,
  readInstalledVersion,
  solidtimeInstalled,
} from "./solidtime-install.mjs";

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
function systemctlActive(user, pveHost, vmid, unit) {
  const r = pctExec(user, pveHost, vmid, `systemctl is-active --quiet ${unit} && echo active`, {
    capture: true,
  });
  return r.status === 0 && r.stdout.trim() === "active";
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} solidtime
 */
export async function querySolidtimeInCt(user, pveHost, vmid, solidtime) {
  const ready = await waitForCt(user, pveHost, vmid, 1500, "solidtime query");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const installed = solidtimeInstalled(user, pveHost, vmid);
  const configuredVersion =
    typeof solidtime.version === "string" && solidtime.version.trim()
      ? normalizeVersionTag(solidtime.version)
      : null;
  const installedVersion = readInstalledVersion(user, pveHost, vmid);
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const appUrl = readAppUrlFromEnv(user, pveHost, vmid);

  const caddyActive = systemctlActive(user, pveHost, vmid, "caddy");
  const phpFpmActive = systemctlActive(user, pveHost, vmid, "php8.3-fpm");
  const pgCheck = pctExec(
    user,
    pveHost,
    vmid,
    "pg_isready -q 2>/dev/null && echo active || systemctl is-active --quiet postgresql@16-main && echo active || systemctl is-active --quiet postgresql && echo active",
    { capture: true },
  );
  const postgresqlActive = pgCheck.status === 0 && pgCheck.stdout.trim().includes("active");

  let httpOk = false;
  if (installed) {
    const probe = pctExec(user, pveHost, vmid, "curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1/ 2>/dev/null || echo fail", {
      capture: true,
    });
    const code = probe.stdout.trim();
    httpOk = code === "200" || code === "302";
  }

  const ok = installed && caddyActive && phpFpmActive && postgresqlActive && httpOk;

  return {
    ok,
    installed,
    configured_version: configuredVersion,
    installed_version: installedVersion,
    caddy_active: caddyActive,
    php_fpm_active: phpFpmActive,
    postgresql_active: postgresqlActive,
    http_ok: httpOk,
    app_url: appUrl,
    ip,
  };
}
