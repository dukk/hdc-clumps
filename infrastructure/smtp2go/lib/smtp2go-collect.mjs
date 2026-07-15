import { buildDnsChecklist, domainVerificationSummary } from "./smtp2go-dns-checklist.mjs";
import { domainPresenceDrift, domainSettingsDrift, liveDomainToConfig } from "./smtp2go-config.mjs";
import { collectRestrictionsState } from "./smtp2go-restrictions-collect.mjs";

export { fetchLiveSmtp2goState } from "./smtp2go-restrictions-collect.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<import('./smtp2go-config.mjs').normalizeSmtp2goConfig>} opts.config
 * @param {{ senderDomains: import('./smtp2go-api.mjs').Smtp2goSenderDomainRow[]; ipAllowList?: import('./smtp2go-api.mjs').Smtp2goIpAllowListState; allowedSenders?: import('./smtp2go-api.mjs').Smtp2goAllowedSendersState }} opts.live
 * @param {string | undefined} [opts.domainIdFilter]
 * @param {string | undefined} [opts.domainFilter]
 */
export function collectSmtp2goState(opts) {
  const { config, live, domainIdFilter, domainFilter } = opts;
  const onlyId = domainIdFilter ? domainIdFilter.trim() : null;
  const onlyFqdn = domainFilter ? domainFilter.trim().toLowerCase() : null;

  let configDomains = config.senderDomains;
  if (onlyId) {
    configDomains = configDomains.filter((d) => d.id === onlyId);
    if (!configDomains.length) {
      throw new Error(`Domain id not found in config: ${onlyId}`);
    }
  }
  if (onlyFqdn) {
    configDomains = configDomains.filter((d) => d.domain === onlyFqdn);
    if (!configDomains.length) {
      throw new Error(`Domain not found in config: ${onlyFqdn}`);
    }
  }

  let liveRows = live.senderDomains;
  if (onlyFqdn) {
    liveRows = liveRows.filter(
      (r) =>
        typeof r.domain?.fulldomain === "string" &&
        r.domain.fulldomain.trim().toLowerCase() === onlyFqdn
    );
  } else if (onlyId && configDomains.length === 1) {
    const fqdn = configDomains[0].domain;
    liveRows = liveRows.filter(
      (r) =>
        typeof r.domain?.fulldomain === "string" &&
        r.domain.fulldomain.trim().toLowerCase() === fqdn
    );
  }

  const liveByFqdn = new Map(
    liveRows
      .map((r) => {
        const fqdn =
          typeof r.domain?.fulldomain === "string" ? r.domain.fulldomain.trim().toLowerCase() : "";
        return fqdn ? [fqdn, r] : null;
      })
      .filter(Boolean)
  );

  const configFqdns = new Set(configDomains.map((d) => d.domain));

  /** @type {Record<string, unknown>[]} */
  const sender_domains = [];
  let hasDrift = false;

  for (const entry of configDomains) {
    const liveRow = liveByFqdn.get(entry.domain) ?? null;
    const presence = domainPresenceDrift(entry, liveRow);
    const settingsDrift = liveRow ? domainSettingsDrift(entry, liveRow) : false;
    const verification = liveRow ? domainVerificationSummary(liveRow) : null;
    const unverifiedManaged =
      entry.managed && liveRow && verification && !verification.fully_verified;
    const entryDrift = presence.missing_in_live || settingsDrift || unverifiedManaged;
    if (entryDrift) hasDrift = true;

    sender_domains.push({
      id: entry.id,
      domain: entry.domain,
      managed: entry.managed,
      in_live: Boolean(liveRow),
      missing_in_live: presence.missing_in_live,
      settings_drift: settingsDrift,
      verification,
      dns_checklist: liveRow
        ? buildDnsChecklist(liveRow, {
            spf: entry.spf ?? undefined,
            dmarc: entry.dmarc,
            spf_variant: entry.spf_variant ?? undefined,
          })
        : [],
      has_drift: entryDrift,
      notes: entry.notes,
    });
  }

  /** @type {Record<string, unknown>[]} */
  const extra_in_live = [];
  for (const row of liveRows) {
    const fqdn =
      typeof row.domain?.fulldomain === "string" ? row.domain.fulldomain.trim().toLowerCase() : "";
    if (!fqdn || configFqdns.has(fqdn)) continue;
    hasDrift = true;
    extra_in_live.push({
      domain: fqdn,
      verification: domainVerificationSummary(row),
      dns_checklist: buildDnsChecklist(row),
      suggested_config_entry: liveDomainToConfig(row),
    });
  }

  const restrictions = collectRestrictionsState({ config, live });
  if (restrictions.has_restrictions_drift) hasDrift = true;

  return {
    sender_domains,
    extra_in_live,
    ip_allow_list: restrictions.ip_allow_list,
    allowed_senders: restrictions.allowed_senders,
    has_drift: hasDrift,
    has_restrictions_drift: restrictions.has_restrictions_drift,
    live_sender_domain_count: live.senderDomains.length,
    configured_sender_domain_count: config.senderDomains.length,
    domain_id_filter: onlyId,
    domain_filter: onlyFqdn,
  };
}
