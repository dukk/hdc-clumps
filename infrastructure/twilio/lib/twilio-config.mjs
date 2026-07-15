import {
  TWILIO_ACCOUNT_SID_VAULT_KEY,
  TWILIO_AUTH_TOKEN_VAULT_KEY,
} from "./vault-deps.mjs";

/**
 * @typedef {{
 *   sid: string;
 *   username: string;
 * }} ConfigCredential
 */

/**
 * @typedef {{
 *   sid: string;
 *   friendly_name: string | null;
 *   credentials: ConfigCredential[];
 * }} ConfigCredentialList
 */

/**
 * @typedef {{
 *   sid: string;
 *   friendly_name: string | null;
 *   sip_url: string;
 *   priority: number;
 *   weight: number;
 *   enabled: boolean;
 * }} ConfigOriginationUrl
 */

/**
 * @typedef {{
 *   sid: string;
 *   phone_number: string;
 * }} ConfigTrunkPhoneNumber
 */

/**
 * @typedef {{
 *   id: string;
 *   sid: string;
 *   friendly_name: string | null;
 *   termination_domain: string;
 *   origination_urls: ConfigOriginationUrl[];
 *   trunk_phone_numbers: ConfigTrunkPhoneNumber[];
 *   credential_lists: ConfigCredentialList[];
 * }} ConfigSipTrunk
 */

/**
 * @typedef {{
 *   sid: string;
 *   phone_number: string;
 *   friendly_name: string | null;
 *   voice_url: string | null;
 *   sms_url: string | null;
 *   trunk_sid: string | null;
 *   capabilities: Record<string, boolean> | null;
 * }} ConfigPhoneNumber
 */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} value
 */
export function slugifyId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * @param {{ sid: string; friendly_name?: string; domain_name?: string }} trunk
 */
export function trunkIdFromLive(trunk) {
  const domain = typeof trunk.domain_name === "string" ? trunk.domain_name.trim() : "";
  if (domain) {
    const prefix = domain.split(".")[0];
    const slug = slugifyId(prefix);
    if (slug) return slug;
  }
  const name = typeof trunk.friendly_name === "string" ? trunk.friendly_name.trim() : "";
  if (name) {
    const slug = slugifyId(name);
    if (slug) return slug;
  }
  const sidTail = trunk.sid ? trunk.sid.replace(/^TK/i, "").slice(-8).toLowerCase() : "";
  return sidTail ? `trunk-${sidTail}` : "trunk";
}

/**
 * @param {import('./twilio-api.mjs').TwilioOriginationUrl} row
 */
export function liveOriginationUrlToConfig(row) {
  return /** @type {ConfigOriginationUrl} */ ({
    sid: row.sid,
    friendly_name: row.friendly_name ?? null,
    sip_url: row.sip_url,
    priority: row.priority,
    weight: row.weight,
    enabled: row.enabled,
  });
}

/**
 * @param {import('./twilio-api.mjs').TwilioCredential} row
 */
export function liveCredentialToConfig(row) {
  return /** @type {ConfigCredential} */ ({
    sid: row.sid,
    username: row.username,
  });
}

/**
 * @param {import('./twilio-api.mjs').TwilioIncomingPhoneNumber} row
 */
export function livePhoneNumberToConfig(row) {
  return /** @type {ConfigPhoneNumber} */ ({
    sid: row.sid,
    phone_number: row.phone_number,
    friendly_name: row.friendly_name ?? null,
    voice_url: row.voice_url ?? null,
    sms_url: row.sms_url ?? null,
    trunk_sid: row.trunk_sid ?? null,
    capabilities: row.capabilities ?? null,
  });
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeTwilioConfig(cfg) {
  const tw = isObject(cfg.twilio) ? cfg.twilio : {};
  const auth = isObject(tw.auth) ? tw.auth : {};
  const accountSidVaultKey =
    typeof auth.account_sid_vault_key === "string" && auth.account_sid_vault_key.trim()
      ? auth.account_sid_vault_key.trim()
      : TWILIO_ACCOUNT_SID_VAULT_KEY;
  const authTokenVaultKey =
    typeof auth.auth_token_vault_key === "string" && auth.auth_token_vault_key.trim()
      ? auth.auth_token_vault_key.trim()
      : TWILIO_AUTH_TOKEN_VAULT_KEY;

  const apiBase =
    typeof tw.api_base_url === "string" && tw.api_base_url.trim()
      ? tw.api_base_url.trim().replace(/\/$/, "")
      : "https://api.twilio.com";
  const trunkingApiBase =
    typeof tw.trunking_api_base_url === "string" && tw.trunking_api_base_url.trim()
      ? tw.trunking_api_base_url.trim().replace(/\/$/, "")
      : "https://trunking.twilio.com";

  /** @type {ConfigSipTrunk[]} */
  const sipTrunks = [];
  const trunkList = Array.isArray(cfg.sip_trunks) ? cfg.sip_trunks : [];
  for (const raw of trunkList) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const sid = typeof raw.sid === "string" ? raw.sid.trim() : "";
    const termination =
      typeof raw.termination_domain === "string" ? raw.termination_domain.trim() : "";
    if (!id || !sid || !termination) continue;

    /** @type {ConfigOriginationUrl[]} */
    const originationUrls = [];
    if (Array.isArray(raw.origination_urls)) {
      for (const ou of raw.origination_urls) {
        if (!isObject(ou)) continue;
        const ouSid = typeof ou.sid === "string" ? ou.sid.trim() : "";
        const sipUrl = typeof ou.sip_url === "string" ? ou.sip_url.trim() : "";
        if (!ouSid || !sipUrl) continue;
        originationUrls.push({
          sid: ouSid,
          friendly_name:
            typeof ou.friendly_name === "string" ? ou.friendly_name.trim() || null : null,
          sip_url: sipUrl,
          priority: Number(ou.priority ?? 0),
          weight: Number(ou.weight ?? 0),
          enabled: ou.enabled !== false,
        });
      }
    }

    /** @type {ConfigTrunkPhoneNumber[]} */
    const trunkPhoneNumbers = [];
    if (Array.isArray(raw.trunk_phone_numbers)) {
      for (const pn of raw.trunk_phone_numbers) {
        if (!isObject(pn)) continue;
        const pnSid = typeof pn.sid === "string" ? pn.sid.trim() : "";
        const phone = typeof pn.phone_number === "string" ? pn.phone_number.trim() : "";
        if (!pnSid || !phone) continue;
        trunkPhoneNumbers.push({ sid: pnSid, phone_number: phone });
      }
    }

    /** @type {ConfigCredentialList[]} */
    const credentialLists = [];
    if (Array.isArray(raw.credential_lists)) {
      for (const cl of raw.credential_lists) {
        if (!isObject(cl)) continue;
        const clSid = typeof cl.sid === "string" ? cl.sid.trim() : "";
        if (!clSid) continue;
        /** @type {ConfigCredential[]} */
        const credentials = [];
        if (Array.isArray(cl.credentials)) {
          for (const cr of cl.credentials) {
            if (!isObject(cr)) continue;
            const crSid = typeof cr.sid === "string" ? cr.sid.trim() : "";
            const username = typeof cr.username === "string" ? cr.username.trim() : "";
            if (!crSid || !username) continue;
            credentials.push({ sid: crSid, username });
          }
        }
        credentialLists.push({
          sid: clSid,
          friendly_name:
            typeof cl.friendly_name === "string" ? cl.friendly_name.trim() || null : null,
          credentials,
        });
      }
    }

    sipTrunks.push({
      id,
      sid,
      friendly_name:
        typeof raw.friendly_name === "string" ? raw.friendly_name.trim() || null : null,
      termination_domain: termination,
      origination_urls: originationUrls,
      trunk_phone_numbers: trunkPhoneNumbers,
      credential_lists: credentialLists,
    });
  }

  /** @type {ConfigPhoneNumber[]} */
  const phoneNumbers = [];
  const pnList = Array.isArray(cfg.phone_numbers) ? cfg.phone_numbers : [];
  for (const raw of pnList) {
    if (!isObject(raw)) continue;
    const sid = typeof raw.sid === "string" ? raw.sid.trim() : "";
    const phone = typeof raw.phone_number === "string" ? raw.phone_number.trim() : "";
    if (!sid || !phone) continue;
    /** @type {Record<string, boolean> | null} */
    let capabilities = null;
    if (isObject(raw.capabilities)) {
      capabilities = {};
      for (const k of ["voice", "sms", "mms", "fax"]) {
        if (typeof raw.capabilities[k] === "boolean") {
          capabilities[k] = raw.capabilities[k];
        }
      }
      if (!Object.keys(capabilities).length) capabilities = null;
    }
    phoneNumbers.push({
      sid,
      phone_number: phone,
      friendly_name:
        typeof raw.friendly_name === "string" ? raw.friendly_name.trim() || null : null,
      voice_url: typeof raw.voice_url === "string" ? raw.voice_url.trim() || null : null,
      sms_url: typeof raw.sms_url === "string" ? raw.sms_url.trim() || null : null,
      trunk_sid:
        typeof raw.trunk_sid === "string" && raw.trunk_sid.trim() ? raw.trunk_sid.trim() : null,
      capabilities,
    });
  }

  const trunksById = new Map(sipTrunks.map((t) => [t.id, t]));
  const trunksBySid = new Map(sipTrunks.map((t) => [t.sid, t]));
  const phoneNumbersBySid = new Map(phoneNumbers.map((p) => [p.sid, p]));

  return {
    accountSid: typeof tw.account_sid === "string" ? tw.account_sid.trim() || null : null,
    friendlyName:
      typeof tw.friendly_name === "string" ? tw.friendly_name.trim() || null : null,
    status: typeof tw.status === "string" ? tw.status.trim() || null : null,
    apiBase,
    trunkingApiBase,
    accountSidVaultKey,
    authTokenVaultKey,
    sipTrunks,
    phoneNumbers,
    trunksById,
    trunksBySid,
    phoneNumbersBySid,
  };
}

/**
 * @param {ConfigSipTrunk} trunk
 */
export function trunkComparable(trunk) {
  return JSON.stringify({
    sid: trunk.sid,
    friendly_name: trunk.friendly_name,
    termination_domain: trunk.termination_domain,
    origination_urls: [...trunk.origination_urls].sort((a, b) => a.sid.localeCompare(b.sid)),
    trunk_phone_numbers: [...trunk.trunk_phone_numbers].sort((a, b) =>
      a.sid.localeCompare(b.sid)
    ),
    credential_lists: [...trunk.credential_lists]
      .map((cl) => ({
        sid: cl.sid,
        friendly_name: cl.friendly_name,
        credentials: [...cl.credentials].sort((a, b) => a.sid.localeCompare(b.sid)),
      }))
      .sort((a, b) => a.sid.localeCompare(b.sid)),
  });
}

/**
 * @param {ConfigPhoneNumber} pn
 */
export function phoneNumberComparable(pn) {
  return JSON.stringify({
    sid: pn.sid,
    phone_number: pn.phone_number,
    friendly_name: pn.friendly_name,
    voice_url: pn.voice_url,
    sms_url: pn.sms_url,
    trunk_sid: pn.trunk_sid,
    capabilities: pn.capabilities,
  });
}

/**
 * @param {ConfigSipTrunk} configured
 * @param {ConfigSipTrunk} live
 */
export function trunkHasDrift(configured, live) {
  return trunkComparable(configured) !== trunkComparable(live);
}

/**
 * @param {ConfigPhoneNumber} configured
 * @param {ConfigPhoneNumber} live
 */
export function phoneNumberHasDrift(configured, live) {
  return phoneNumberComparable(configured) !== phoneNumberComparable(live);
}
