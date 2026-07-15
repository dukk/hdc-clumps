import { createTwilioClient } from "./twilio-api.mjs";
import {
  liveCredentialToConfig,
  liveOriginationUrlToConfig,
  livePhoneNumberToConfig,
  phoneNumberHasDrift,
  trunkHasDrift,
  trunkIdFromLive,
} from "./twilio-config.mjs";

/**
 * @param {ReturnType<typeof createTwilioClient>} api
 * @param {(line: string) => void} [log]
 */
export async function fetchLiveTwilioState(api, log = () => {}) {
  log("fetching account metadata");
  const account = await api.getAccount();

  log("fetching incoming phone numbers");
  const incomingPhoneNumbers = await api.listIncomingPhoneNumbers();

  log("fetching SIP trunks");
  const trunkRows = await api.listTrunks();

  /** @type {import('./twilio-config.mjs').ConfigSipTrunk[]} */
  const sipTrunks = [];
  for (const trunk of trunkRows) {
    log(`fetching subresources for trunk ${trunk.sid}`);
    const [originationUrls, trunkPhoneNumbers, credentialListRefs] = await Promise.all([
      api.listOriginationUrls(trunk.sid),
      api.listTrunkPhoneNumbers(trunk.sid),
      api.listTrunkCredentialLists(trunk.sid),
    ]);

    /** @type {import('./twilio-config.mjs').ConfigCredentialList[]} */
    const credentialLists = [];
    for (const clRef of credentialListRefs) {
      try {
        const credentials = await api.listCredentials(clRef.sid);
        credentialLists.push({
          sid: clRef.sid,
          friendly_name: clRef.friendly_name ?? null,
          credentials: credentials.map(liveCredentialToConfig),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`warning: could not list credentials for ${clRef.sid}: ${msg}`);
        credentialLists.push({
          sid: clRef.sid,
          friendly_name: clRef.friendly_name ?? null,
          credentials: [],
        });
      }
    }

    sipTrunks.push({
      id: trunkIdFromLive(trunk),
      sid: trunk.sid,
      friendly_name: trunk.friendly_name ?? null,
      termination_domain: trunk.domain_name,
      origination_urls: originationUrls.map(liveOriginationUrlToConfig),
      trunk_phone_numbers: trunkPhoneNumbers.map((pn) => ({
        sid: pn.sid,
        phone_number: pn.phone_number,
      })),
      credential_lists: credentialLists,
    });
  }

  const phoneNumbers = incomingPhoneNumbers.map(livePhoneNumberToConfig);

  return {
    account,
    sipTrunks,
    phoneNumbers,
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./twilio-config.mjs').normalizeTwilioConfig>} opts.config
 * @param {{ account: { sid: string; friendly_name?: string; status?: string }; sipTrunks: import('./twilio-config.mjs').ConfigSipTrunk[]; phoneNumbers: import('./twilio-config.mjs').ConfigPhoneNumber[] }} opts.live
 * @param {string | undefined} [opts.trunkFilterId]
 */
export function collectTwilioState(opts) {
  const { config, live, trunkFilterId } = opts;
  const onlyTrunk = trunkFilterId ? trunkFilterId.trim() : null;

  const liveTrunks = onlyTrunk
    ? live.sipTrunks.filter((t) => t.id === onlyTrunk)
    : live.sipTrunks;
  const configTrunks = onlyTrunk
    ? config.sipTrunks.filter((t) => t.id === onlyTrunk)
    : config.sipTrunks;

  if (onlyTrunk && liveTrunks.length === 0 && configTrunks.length === 0) {
    throw new Error(`Trunk not found in config or live account: ${onlyTrunk}`);
  }

  const liveTrunksBySid = new Map(liveTrunks.map((t) => [t.sid, t]));
  const configTrunksBySid = new Map(configTrunks.map((t) => [t.sid, t]));

  /** @type {{ id: string; sid: string; drift: boolean; missing_in_live: boolean; missing_in_config: boolean }[]} */
  const sip_trunks = [];
  let trunkDrift = false;

  for (const cfgTrunk of configTrunks) {
    const liveTrunk = liveTrunksBySid.get(cfgTrunk.sid);
    if (!liveTrunk) {
      trunkDrift = true;
      sip_trunks.push({
        id: cfgTrunk.id,
        sid: cfgTrunk.sid,
        drift: true,
        missing_in_live: true,
        missing_in_config: false,
      });
      continue;
    }
    const drift = trunkHasDrift(cfgTrunk, liveTrunk);
    if (drift) trunkDrift = true;
    sip_trunks.push({
      id: cfgTrunk.id,
      sid: cfgTrunk.sid,
      drift,
      missing_in_live: false,
      missing_in_config: false,
    });
  }

  for (const liveTrunk of liveTrunks) {
    if (!configTrunksBySid.has(liveTrunk.sid)) {
      trunkDrift = true;
      sip_trunks.push({
        id: liveTrunk.id,
        sid: liveTrunk.sid,
        drift: true,
        missing_in_live: false,
        missing_in_config: true,
      });
    }
  }

  const livePnBySid = new Map(live.phoneNumbers.map((p) => [p.sid, p]));
  const configPnBySid = new Map(config.phoneNumbers.map((p) => [p.sid, p]));

  /** @type {{ sid: string; phone_number: string; drift: boolean; missing_in_live: boolean; missing_in_config: boolean }[]} */
  const phone_numbers = [];
  let phoneDrift = false;

  if (!onlyTrunk) {
    for (const cfgPn of config.phoneNumbers) {
      const livePn = livePnBySid.get(cfgPn.sid);
      if (!livePn) {
        phoneDrift = true;
        phone_numbers.push({
          sid: cfgPn.sid,
          phone_number: cfgPn.phone_number,
          drift: true,
          missing_in_live: true,
          missing_in_config: false,
        });
        continue;
      }
      const drift = phoneNumberHasDrift(cfgPn, livePn);
      if (drift) phoneDrift = true;
      phone_numbers.push({
        sid: cfgPn.sid,
        phone_number: cfgPn.phone_number,
        drift,
        missing_in_live: false,
        missing_in_config: false,
      });
    }

    for (const livePn of live.phoneNumbers) {
      if (!configPnBySid.has(livePn.sid)) {
        phoneDrift = true;
        phone_numbers.push({
          sid: livePn.sid,
          phone_number: livePn.phone_number,
          drift: true,
          missing_in_live: false,
          missing_in_config: true,
        });
      }
    }
  }

  const accountDrift =
    (config.accountSid && config.accountSid !== live.account.sid) ||
    (config.friendlyName && live.account.friendly_name && config.friendlyName !== live.account.friendly_name) ||
    (config.status && live.account.status && config.status !== live.account.status);

  return {
    account: {
      sid: live.account.sid,
      friendly_name: live.account.friendly_name ?? null,
      status: live.account.status ?? null,
      drift: Boolean(accountDrift),
    },
    sip_trunks,
    phone_numbers,
    has_drift: trunkDrift || phoneDrift || Boolean(accountDrift),
    live_sip_trunk_count: live.sipTrunks.length,
    live_phone_number_count: live.phoneNumbers.length,
    configured_sip_trunk_count: config.sipTrunks.length,
    configured_phone_number_count: config.phoneNumbers.length,
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./twilio-config.mjs').normalizeTwilioConfig>} opts.config
 * @param {ReturnType<typeof createTwilioClient>} opts.api
 * @param {string | undefined} [opts.trunkFilterId]
 * @param {(line: string) => void} [opts.log]
 */
export async function collectTwilioStateFromApi(opts) {
  const live = await fetchLiveTwilioState(opts.api, opts.log);
  const state = collectTwilioState({
    config: opts.config,
    live,
    trunkFilterId: opts.trunkFilterId,
  });
  return { live, state };
}
