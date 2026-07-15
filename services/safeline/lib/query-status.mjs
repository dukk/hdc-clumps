import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { fetchLiveSitesViaPct } from "./safeline-api.mjs";
import { composeDir, mgtPort, resolveMgtUrl } from "./safeline-render.mjs";
import { normalizeLiveSiteList, summarizeSiteDrift } from "./safeline-sites-sync.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} safeline
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>[]} configSites
 * @param {string | null} apiToken
 */
export async function querySafelineInCt(user, pveHost, vmid, safeline, install, configSites, apiToken) {
  const port = mgtPort(safeline);
  const dir = composeDir(isObject(install) ? install : {});

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
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose -f compose.yaml ps --format json 2>/dev/null || docker compose -f compose.yaml ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  let healthOk = null;
  let healthError = null;
  if (docker.stdout.trim() === "active") {
    const healthCmd = `curl -skf --max-time 5 https://127.0.0.1:${port}/api/open/health -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") healthOk = true;
    else {
      healthOk = false;
      healthError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  /** @type {Record<string, unknown> | null} */
  let siteDrift = null;
  if (apiToken && healthOk) {
    try {
      const liveBody = fetchLiveSitesViaPct(user, pveHost, vmid, safeline, apiToken);
      const liveSites = normalizeLiveSiteList(liveBody);
      siteDrift = summarizeSiteDrift(configSites, liveSites);
    } catch (e) {
      siteDrift = { error: String(/** @type {Error} */ (e).message || e) };
    }
  }

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    mgt_url: resolveMgtUrl(ctIp, safeline),
    health_ok: healthOk,
    health_error: healthError,
    mgt_port: port,
    site_drift: siteDrift,
    api_token_present: Boolean(apiToken),
  };
}
