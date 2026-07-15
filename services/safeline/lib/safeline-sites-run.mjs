import { stderr as errout } from "node:process";

import { applySiteSyncPlan, fetchLiveSitesViaPct } from "./safeline-api.mjs";
import { planSiteSync, normalizeLiveSiteList } from "./safeline-sites-sync.mjs";

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} safeline
 * @param {Record<string, unknown>[]} sites
 * @param {string} apiToken
 * @param {{ prune?: boolean; siteFilter?: string | null }} opts
 */
export async function syncSafelineSites(user, pveHost, vmid, safeline, sites, apiToken, opts = {}) {
  errout.write(`[hdc] safeline sites: reconciling ${sites.length} config site(s) …\n`);
  const liveBody = fetchLiveSitesViaPct(user, pveHost, vmid, safeline, apiToken);
  const liveSites = normalizeLiveSiteList(liveBody);
  const plan = planSiteSync(sites, liveSites, {
    prune: opts.prune === true,
    siteFilter: opts.siteFilter ?? null,
  });
  const applied = await applySiteSyncPlan(user, pveHost, vmid, safeline, apiToken, plan);
  return {
    ok: applied.ok,
    plan,
    applied,
  };
}
