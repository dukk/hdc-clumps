import {
  liveAllowedSendersToConfig,
  liveIpAllowListToConfig,
  normalizeSmtp2goConfig,
} from "./smtp2go-config.mjs";

/**
 * @param {{ ipAllowList?: import('./smtp2go-api.mjs').Smtp2goIpAllowListState; allowedSenders?: import('./smtp2go-api.mjs').Smtp2goAllowedSendersState }} live
 * @param {Record<string, unknown>} cfgRaw
 */
export function liveStateToRestrictions(live, cfgRaw) {
  const normalized = normalizeSmtp2goConfig(cfgRaw);

  return {
    ip_allow_list: liveIpAllowListToConfig(live.ipAllowList ?? { enabled: false, ip_addresses: [] }, normalized.ipAllowList),
    allowed_senders: liveAllowedSendersToConfig(
      live.allowedSenders ?? { mode: "disabled", allowed_senders: [] },
      normalized.allowedSenders
    ),
  };
}
