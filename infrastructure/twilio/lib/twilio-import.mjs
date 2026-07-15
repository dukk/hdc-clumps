import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";

const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/twilio/config.example.json";

export const TWILIO_COMPACT_ARRAY_KEYS = [
  "sip_trunks",
  "phone_numbers",
  "origination_urls",
  "trunk_phone_numbers",
  "credential_lists",
  "credentials",
];

/**
 * @param {import('./twilio-collect.mjs').fetchLiveTwilioState extends (...args: unknown[]) => Promise<infer R> ? R : never} live
 */
export function liveStateToConfigEntries(live) {
  return {
    account_sid: live.account.sid,
    friendly_name: live.account.friendly_name ?? null,
    status: live.account.status ?? null,
    sip_trunks: live.sipTrunks,
    phone_numbers: live.phoneNumbers,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {Awaited<ReturnType<import('./twilio-collect.mjs').fetchLiveTwilioState>>} opts.live
 * @param {(line: string) => void} [opts.log]
 */
export function importTwilioToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });

  const entries = liveStateToConfigEntries(opts.live);
  const twilioRaw = cfgRaw.twilio && typeof cfgRaw.twilio === "object" ? { ...cfgRaw.twilio } : {};

  const next = {
    ...cfgRaw,
    twilio: {
      ...twilioRaw,
      account_sid: entries.account_sid,
      friendly_name: entries.friendly_name,
      status: entries.status,
    },
    sip_trunks: entries.sip_trunks,
    phone_numbers: entries.phone_numbers,
  };

  writeResolvedRepoJson(resolved, next, { compactArrayKeys: TWILIO_COMPACT_ARRAY_KEYS });
  log(
    `Wrote ${entries.sip_trunks.length} SIP trunk(s), ${entries.phone_numbers.length} phone number(s) to config (${source}: ${resolved.rel}).`
  );

  return {
    sip_trunk_count: entries.sip_trunks.length,
    phone_number_count: entries.phone_numbers.length,
    configPath: resolved.path,
    configRel: resolved.rel,
    source,
  };
}
