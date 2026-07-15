import { stderr as errout } from "node:process";

import { createCloudflareClient } from "../../../infrastructure/cloudflare/lib/cloudflare-api.mjs";
import { normalizeZoneName } from "../../../infrastructure/cloudflare/lib/cloudflare-config.mjs";
import { applyZoneSync, planZoneSync } from "../../../infrastructure/cloudflare/lib/cloudflare-sync.mjs";
import { createCloudflareVaultAccess, resolveCloudflareToken } from "../../../infrastructure/cloudflare/lib/vault-deps.mjs";

import { dkimOwnerName } from "./mailcow-dns.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>[]} domainResults
 * @param {{ log?: (line: string) => void; dryRun?: boolean }} [opts]
 */
export async function publishMailcowDkimToCloudflare(domainResults, opts = {}) {
  const log = opts.log ?? ((line) => errout.write(`[hdc] mailcow: ${line}\n`));
  const dryRun = Boolean(opts.dryRun);

  /** @type {Record<string, unknown>[]} */
  const publishable = domainResults.filter((row) => {
    if (row.ok === false) return false;
    const txt = typeof row.dkim_txt === "string" ? row.dkim_txt.trim() : "";
    const domain = typeof row.domain === "string" ? row.domain.trim() : "";
    const selector =
      typeof row.dkim_selector === "string" && row.dkim_selector.trim()
        ? row.dkim_selector.trim()
        : "dkim";
    return Boolean(domain && txt);
  });

  if (!publishable.length) {
    return { ok: true, skipped: true, message: "no DKIM keys to publish", results: [] };
  }

  let token;
  try {
    const vault = createCloudflareVaultAccess();
    token = await resolveCloudflareToken(vault);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    log(`Cloudflare DKIM publish skipped — ${msg}`);
    return { ok: true, skipped: true, message: msg, results: [] };
  }

  const api = createCloudflareClient({ token });
  log(`listing Cloudflare zones for DKIM publish (${publishable.length} domain(s))`);
  const allZones = await api.listZones();
  const zoneByName = new Map(allZones.map((z) => [normalizeZoneName(z.name), z]));

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let failed = 0;

  for (const row of publishable) {
    const domain = String(row.domain).trim();
    const selector =
      typeof row.dkim_selector === "string" && row.dkim_selector.trim()
        ? row.dkim_selector.trim()
        : "dkim";
    const dkimTxt = String(row.dkim_txt).trim();
    const zoneKey = normalizeZoneName(domain);
    const cfZone = zoneByName.get(zoneKey);

    /** @type {Record<string, unknown>} */
    const result = {
      domain,
      zone: zoneKey,
      record_name: dkimOwnerName(domain, selector),
      ok: true,
      action: null,
      message: "ok",
    };

    if (!cfZone) {
      result.ok = false;
      result.message = `Cloudflare zone not found: ${domain}`;
      failed += 1;
      log(`DKIM publish ${domain}: skipped — zone not in account`);
      results.push(result);
      continue;
    }

    const desired = [
      {
        type: "TXT",
        name: dkimOwnerName(domain, selector),
        data: dkimTxt,
        ttl: 300,
        proxied: false,
      },
    ];

    try {
      const liveDns = await api.listDnsRecords(cfZone.id);
      const plan = planZoneSync({
        desired,
        live: liveDns,
        zoneName: domain,
        prune: false,
      });
      log(
        `DKIM ${domain}: plan create=${plan.summary.create} update=${plan.summary.update} unchanged=${plan.summary.unchanged}`,
      );
      const apply = await applyZoneSync(api, cfZone.id, domain, plan, {
        dryRun,
        log: (line) => log(`DKIM ${domain}: ${line}`),
      });
      if (!apply.ok) {
        const failedApply = apply.results.filter((r) => !r.ok);
        result.ok = false;
        result.message = failedApply.map((r) => r.error || r.action).join("; ");
        failed += 1;
      } else if (plan.summary.create) {
        result.action = "created";
      } else if (plan.summary.update) {
        result.action = "updated";
      } else {
        result.action = "unchanged";
      }
    } catch (e) {
      result.ok = false;
      result.message = String(/** @type {Error} */ (e).message || e);
      failed += 1;
      log(`DKIM publish ${domain}: failed — ${result.message}`);
    }

    results.push(result);
  }

  return {
    ok: failed === 0,
    skipped: false,
    published_count: results.filter((r) => r.ok && r.action !== "unchanged").length,
    unchanged_count: results.filter((r) => r.ok && r.action === "unchanged").length,
    failed_count: failed,
    results,
  };
}
