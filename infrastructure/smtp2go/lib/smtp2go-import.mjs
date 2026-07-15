import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import {
  liveDomainToConfig,
} from "./smtp2go-config.mjs";
import { liveStateToRestrictions } from "./smtp2go-import-restrictions.mjs";

export { liveStateToRestrictions } from "./smtp2go-import-restrictions.mjs";

export const SMTP2GO_COMPACT_ARRAY_KEYS = ["sender_domains"];

const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/smtp2go/config.example.json";

/**
 * @param {{ senderDomains: import('./smtp2go-api.mjs').Smtp2goSenderDomainRow[] }} live
 * @param {Map<string, import('./smtp2go-config.mjs').ConfigSenderDomain>} existingByFqdn
 */
export function liveStateToSenderDomains(live, existingByFqdn) {
  return live.senderDomains
    .map((row) => {
      const fqdn =
        typeof row.domain?.fulldomain === "string"
          ? row.domain.fulldomain.trim().toLowerCase()
          : "";
      if (!fqdn) return null;
      const existing = existingByFqdn.get(fqdn) ?? null;
      return liveDomainToConfig(row, existing);
    })
    .filter(Boolean)
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {{ senderDomains: import('./smtp2go-api.mjs').Smtp2goSenderDomainRow[]; ipAllowList?: import('./smtp2go-api.mjs').Smtp2goIpAllowListState; allowedSenders?: import('./smtp2go-api.mjs').Smtp2goAllowedSendersState }} opts.live
 * @param {(line: string) => void} [opts.log]
 */
export function importSmtp2goToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });

  const config = /** @type {import('./smtp2go-config.mjs').ConfigSenderDomain[]} */ (
    Array.isArray(cfgRaw.sender_domains) ? cfgRaw.sender_domains : []
  );
  const existingByFqdn = new Map(
    config
      .filter((d) => d && typeof d.domain === "string")
      .map((d) => [String(d.domain).trim().toLowerCase(), d])
  );

  const sender_domains = liveStateToSenderDomains(opts.live, existingByFqdn);
  const restrictions = liveStateToRestrictions(opts.live, cfgRaw);

  const next = {
    ...cfgRaw,
    sender_domains,
    ip_allow_list: restrictions.ip_allow_list,
    allowed_senders: restrictions.allowed_senders,
  };

  writeResolvedRepoJson(resolved, next, { compactArrayKeys: SMTP2GO_COMPACT_ARRAY_KEYS });
  log(
    `Wrote ${sender_domains.length} sender domain(s) to config (${source}: ${resolved.rel}).`
  );

  return {
    sender_domain_count: sender_domains.length,
    configRel: resolved.rel,
  };
}
