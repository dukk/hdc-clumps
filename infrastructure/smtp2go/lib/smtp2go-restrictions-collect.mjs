import {
  allowedSendersDrift,
  ipAllowListDrift,
  liveAllowedSendersToConfig,
  liveIpAllowListToConfig,
} from "./smtp2go-config.mjs";

/**
 * @param {ReturnType<import('./smtp2go-api.mjs').createSmtp2goClient>} api
 * @param {(line: string) => void} [log]
 */
export async function fetchLiveSmtp2goState(api, log = () => {}) {
  log("fetching sender domains, IP allowlist, and allowed senders");
  const [senderDomains, ipAllowList, allowedSenders] = await Promise.all([
    api.listSenderDomains(),
    api.viewIpAllowList(),
    api.viewAllowedSenders(),
  ]);
  return { senderDomains, ipAllowList, allowedSenders };
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./smtp2go-config.mjs').normalizeSmtp2goConfig>} opts.config
 * @param {Awaited<ReturnType<typeof fetchLiveSmtp2goState>>} opts.live
 */
export function collectRestrictionsState(opts) {
  const { config, live } = opts;
  const ipDrift = ipAllowListDrift(config.ipAllowList, live.ipAllowList ?? null);
  const sendersDrift = allowedSendersDrift(config.allowedSenders, live.allowedSenders ?? null);

  return {
    ip_allow_list: {
      managed: config.ipAllowList.managed,
      enabled: config.ipAllowList.enabled,
      entries: config.ipAllowList.entries,
      in_live: Boolean(live.ipAllowList),
      live_enabled: live.ipAllowList?.enabled === true,
      live_entry_count: Array.isArray(live.ipAllowList?.ip_addresses)
        ? live.ipAllowList.ip_addresses.length
        : 0,
      ...ipDrift,
    },
    allowed_senders: {
      managed: config.allowedSenders.managed,
      mode: config.allowedSenders.mode,
      senders: config.allowedSenders.senders,
      in_live: Boolean(live.allowedSenders),
      live_mode: live.allowedSenders?.mode ?? "disabled",
      live_sender_count: Array.isArray(live.allowedSenders?.allowed_senders)
        ? live.allowedSenders.allowed_senders.length
        : 0,
      ...sendersDrift,
      conflicts_with_sender_domains:
        config.allowedSenders.managed &&
        (config.allowedSenders.mode === "whitelist" ||
          config.allowedSenders.mode === "blacklist") &&
        config.senderDomains.some((d) => d.managed),
    },
    has_restrictions_drift: ipDrift.has_drift || sendersDrift.has_drift,
  };
}

export { liveAllowedSendersToConfig, liveIpAllowListToConfig };
