import { stderr as errout } from "node:process";

import { buildAllDnsChecklists, formatDnsChecklistMarkdown } from "./mailcow-dns.mjs";
import { createMailcowApiClient, reconcileMailcowDomains } from "./mailcow-api.mjs";
import { publishMailcowDkimToCloudflare } from "./mailcow-cloudflare-dkim.mjs";
import {
  cloudflareDkimPublishEnabled,
  normalizeDomainList,
  normalizeHostname,
  resolveApiBaseUrl,
} from "./mailcow-render.mjs";
import { resolveMailcowApiKey } from "./vault-secrets.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} mailcowCfg
 * @param {ReturnType<import("./vault-deps.mjs").createMailcowVaultAccess>} vault
 * @param {{
 *   skipDomains?: boolean;
 *   skipCloudflareDkim?: boolean;
 *   dryRun?: boolean;
 *   log?: (line: string) => void;
 *   requiredApiKey?: boolean;
 *   apiKey?: string | null;
 * }} [opts]
 */
export async function reconcileMailcowDomainsForConfig(mailcowCfg, vault, opts = {}) {
  const log = opts.log ?? ((line) => errout.write(`[hdc] mailcow: ${line}\n`));
  const mc = isObject(mailcowCfg) ? mailcowCfg : {};
  const configuredDomains = normalizeDomainList(mc);
  const hostname = normalizeHostname(mc);

  /** @type {Record<string, unknown>[]} */
  let domainResults = [];
  /** @type {unknown[]} */
  let dnsChecklists = [];
  let domainsSkipped = false;
  let apiOk = null;
  /** @type {string | null} */
  let apiError = null;
  /** @type {Record<string, unknown> | null} */
  let reconcileSummary = null;
  /** @type {Record<string, unknown> | null} */
  let cloudflareDkim = null;

  if (opts.skipDomains) {
    domainsSkipped = true;
    log("--skip-domains — API reconciliation skipped.");
    dnsChecklists = buildAllDnsChecklists(configuredDomains, hostname, {});
    return {
      domain_results: domainResults,
      dns_checklists: dnsChecklists,
      domains_skipped: domainsSkipped,
      configured_domain_count: configuredDomains.length,
      api_ok: apiOk,
      api_error: apiError,
      reconcile_summary: reconcileSummary,
      cloudflare_dkim: cloudflareDkim,
    };
  }

  const apiKey =
    opts.apiKey !== undefined
      ? opts.apiKey
      : await resolveMailcowApiKey(vault, mc, { required: Boolean(opts.requiredApiKey) });

  if (!apiKey) {
    domainsSkipped = true;
    if (configuredDomains.length > 0) {
      log(
        `WARNING: ${configuredDomains.length} domain(s) configured but API key missing — run: node apps/hdc-cli/cli.mjs secrets set HDC_MAILCOW_API_KEY`,
      );
    }
    dnsChecklists = buildAllDnsChecklists(configuredDomains, hostname, {});
    return {
      domain_results: domainResults,
      dns_checklists: dnsChecklists,
      domains_skipped: domainsSkipped,
      configured_domain_count: configuredDomains.length,
      api_ok: false,
      api_error: "API key not set",
      reconcile_summary: reconcileSummary,
      cloudflare_dkim: cloudflareDkim,
    };
  }

  log(`reconciling ${configuredDomains.length} domain(s) via API (${resolveApiBaseUrl(mc)}) …`);
  try {
    const client = createMailcowApiClient(resolveApiBaseUrl(mc), apiKey);
    const reconcile = await reconcileMailcowDomains(configuredDomains, client, { log });
    domainResults = reconcile.domain_results;
    reconcileSummary = reconcile.summary;
    apiOk = true;

    /** @type {Record<string, { dkim_txt?: string | null; dkim_selector?: string | null }>} */
    const liveByDomain = {};
    for (const row of domainResults) {
      const name = typeof row.domain === "string" ? row.domain : "";
      if (!name) continue;
      liveByDomain[name] = {
        dkim_txt: typeof row.dkim_txt === "string" ? row.dkim_txt : null,
        dkim_selector: typeof row.dkim_selector === "string" ? row.dkim_selector : null,
      };
    }
    dnsChecklists = buildAllDnsChecklists(configuredDomains, hostname, liveByDomain);
    for (const checklist of dnsChecklists) {
      log(`DNS checklist for ${checklist.domain} (${checklist.outbound_mode}):`);
      log(formatDnsChecklistMarkdown(checklist.records));
    }

    if (!opts.skipCloudflareDkim && cloudflareDkimPublishEnabled(mc)) {
      cloudflareDkim = await publishMailcowDkimToCloudflare(domainResults, {
        log,
        dryRun: opts.dryRun,
      });
    } else if (opts.skipCloudflareDkim) {
      log("--skip-cloudflare-dkim — DKIM TXT publish skipped.");
    }
  } catch (e) {
    apiOk = false;
    apiError = String(/** @type {Error} */ (e).message || e);
    log(`domain reconciliation failed: ${apiError}`);
    dnsChecklists = buildAllDnsChecklists(configuredDomains, hostname, {});
  }

  return {
    domain_results: domainResults,
    dns_checklists: dnsChecklists,
    domains_skipped: domainsSkipped,
    configured_domain_count: configuredDomains.length,
    api_ok: apiOk,
    api_error: apiError,
    reconcile_summary: reconcileSummary,
    cloudflare_dkim: cloudflareDkim,
  };
}
