import { SMTP2GO_API_KEY_VAULT_KEY } from "./vault-deps.mjs";

/**
 * @typedef {{
 *   id: string;
 *   domain: string;
 *   managed: boolean;
 *   tracking_subdomain: string | null;
 *   returnpath_subdomain: string | null;
 *   notes: string | null;
 *   dmarc: string | null;
 *   spf: string | null;
 *   spf_variant: "default" | "mailcow" | null;
 * }} ConfigSenderDomain
 */

/** @typedef {{ ip_address: string; description: string | null }} ConfigIpAllowListEntry */

/** @typedef {{ managed: boolean; enabled: boolean; entries: ConfigIpAllowListEntry[] }} ConfigIpAllowList */

/** @typedef {"whitelist" | "blacklist" | "disabled"} AllowedSendersMode */

/** @typedef {{ managed: boolean; mode: AllowedSendersMode; senders: string[] }} ConfigAllowedSenders */

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
 * @param {string} fqdn
 */
export function domainIdFromFqdn(fqdn) {
  return slugifyId(fqdn.replace(/\./g, "-"));
}

/**
 * Normalize IP for comparison (strip trailing /32).
 * @param {string} ip
 */
export function normalizeIpAddress(ip) {
  const s = String(ip ?? "").trim();
  if (!s) return "";
  return s.replace(/\/32$/, "");
}

/**
 * @param {string} sender
 */
export function normalizeAllowedSender(sender) {
  return String(sender ?? "").trim().toLowerCase();
}

/**
 * @param {import('./smtp2go-api.mjs').Smtp2goIpAllowListState} live
 * @param {ConfigIpAllowList | null} [existing]
 */
export function liveIpAllowListToConfig(live, existing = null) {
  const liveEntries = Array.isArray(live.ip_addresses) ? live.ip_addresses : [];
  const existingByIp = new Map(
    (existing?.entries ?? [])
      .filter((e) => e && typeof e.ip_address === "string")
      .map((e) => [normalizeIpAddress(e.ip_address), e])
  );

  /** @type {ConfigIpAllowListEntry[]} */
  const entries = liveEntries
    .map((row) => {
      const ip =
        typeof row.ip_address === "string" ? normalizeIpAddress(row.ip_address) : "";
      if (!ip) return null;
      const prev = existingByIp.get(ip);
      const liveDesc =
        typeof row.description === "string" ? row.description.trim() || null : null;
      return {
        ip_address: ip,
        description: prev?.description ?? liveDesc,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ip_address.localeCompare(b.ip_address));

  return {
    managed: existing?.managed ?? false,
    enabled: live.enabled === true,
    entries,
  };
}

/**
 * @param {import('./smtp2go-api.mjs').Smtp2goAllowedSendersState} live
 * @param {ConfigAllowedSenders | null} [existing]
 */
export function liveAllowedSendersToConfig(live, existing = null) {
  const mode =
    live.mode === "whitelist" || live.mode === "blacklist" ? live.mode : "disabled";
  const senders = Array.isArray(live.allowed_senders)
    ? [...live.allowed_senders]
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean)
        .sort((a, b) => normalizeAllowedSender(a).localeCompare(normalizeAllowedSender(b)))
    : [];

  return {
    managed: existing?.managed ?? false,
    mode,
    senders,
  };
}

/**
 * @param {ConfigIpAllowList} config
 * @param {import('./smtp2go-api.mjs').Smtp2goIpAllowListState | null} live
 */
export function ipAllowListDrift(config, live) {
  if (!live) {
    return {
      has_drift: config.entries.length > 0 || config.enabled,
      enabled_drift: config.enabled,
      missing_in_live: config.entries.map((e) => e.ip_address),
      extra_in_live: [],
      description_drift: [],
    };
  }

  const liveByIp = new Map(
    (Array.isArray(live.ip_addresses) ? live.ip_addresses : [])
      .map((row) => {
        const ip =
          typeof row.ip_address === "string" ? normalizeIpAddress(row.ip_address) : "";
        return ip ? [ip, row] : null;
      })
      .filter(Boolean)
  );

  const configIps = new Set(config.entries.map((e) => normalizeIpAddress(e.ip_address)));

  /** @type {string[]} */
  const missing_in_live = [];
  /** @type {{ ip_address: string; description: string | null }[]} */
  const description_drift = [];

  for (const entry of config.entries) {
    const ip = normalizeIpAddress(entry.ip_address);
    const liveRow = liveByIp.get(ip);
    if (!liveRow) {
      missing_in_live.push(ip);
      continue;
    }
    const liveDesc =
      typeof liveRow.description === "string" ? liveRow.description.trim() || null : null;
    const configDesc = entry.description ?? null;
    if (configDesc !== liveDesc) {
      description_drift.push({ ip_address: ip, description: configDesc });
    }
  }

  /** @type {string[]} */
  const extra_in_live = [];
  for (const ip of liveByIp.keys()) {
    if (!configIps.has(ip)) extra_in_live.push(ip);
  }

  const enabled_drift = config.enabled !== (live.enabled === true);
  const has_drift =
    enabled_drift ||
    missing_in_live.length > 0 ||
    extra_in_live.length > 0 ||
    description_drift.length > 0;

  return { has_drift, enabled_drift, missing_in_live, extra_in_live, description_drift };
}

/**
 * @param {ConfigAllowedSenders} config
 * @param {import('./smtp2go-api.mjs').Smtp2goAllowedSendersState | null} live
 */
export function allowedSendersDrift(config, live) {
  if (!live) {
    return {
      has_drift: config.senders.length > 0 || config.mode !== "disabled",
      mode_drift: config.mode !== "disabled",
      missing_in_live: [...config.senders],
      extra_in_live: [],
    };
  }

  const configSet = new Set(config.senders.map(normalizeAllowedSender));
  const liveSet = new Set(
    (Array.isArray(live.allowed_senders) ? live.allowed_senders : []).map(normalizeAllowedSender)
  );

  /** @type {string[]} */
  const missing_in_live = [];
  for (const sender of config.senders) {
    if (!liveSet.has(normalizeAllowedSender(sender))) missing_in_live.push(sender);
  }

  /** @type {string[]} */
  const extra_in_live = [];
  for (const sender of live.allowed_senders ?? []) {
    if (!configSet.has(normalizeAllowedSender(sender))) extra_in_live.push(sender);
  }

  const mode_drift = config.mode !== live.mode;
  const has_drift = mode_drift || missing_in_live.length > 0 || extra_in_live.length > 0;

  return { has_drift, mode_drift, missing_in_live, extra_in_live };
}

/**
 * @param {import('./smtp2go-api.mjs').Smtp2goSenderDomainRow} row
 * @param {ConfigSenderDomain | null} [existing]
 */
export function liveDomainToConfig(row, existing = null) {
  const fulldomain =
    typeof row.domain?.fulldomain === "string" ? row.domain.fulldomain.trim() : "";
  const tracker = Array.isArray(row.trackers) ? row.trackers.find((t) => t.enabled !== false) : null;
  const trackingSub =
    tracker && typeof tracker.subdomain === "string" ? tracker.subdomain.trim() || null : null;
  const rpath =
    typeof row.domain?.rpath_selector === "string" ? row.domain.rpath_selector.trim() || null : null;

  return /** @type {ConfigSenderDomain} */ ({
    id: existing?.id || domainIdFromFqdn(fulldomain),
    domain: fulldomain,
    managed: existing?.managed ?? false,
    tracking_subdomain: trackingSub ?? existing?.tracking_subdomain ?? null,
    returnpath_subdomain: rpath ?? existing?.returnpath_subdomain ?? null,
    notes: existing?.notes ?? null,
    dmarc: existing?.dmarc ?? null,
    spf: existing?.spf ?? null,
    spf_variant: existing?.spf_variant ?? null,
  });
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeSmtp2goConfig(cfg) {
  const sg = isObject(cfg.smtp2go) ? cfg.smtp2go : {};
  const auth = isObject(sg.auth) ? sg.auth : {};
  const apiKeyVaultKey =
    typeof auth.api_key_vault_key === "string" && auth.api_key_vault_key.trim()
      ? auth.api_key_vault_key.trim()
      : SMTP2GO_API_KEY_VAULT_KEY;

  const apiBase =
    typeof sg.api_base_url === "string" && sg.api_base_url.trim()
      ? sg.api_base_url.trim().replace(/\/$/, "")
      : "https://api.smtp2go.com/v3";

  const defaultsRaw = isObject(cfg.defaults) ? cfg.defaults : {};
  const trackingDefault =
    typeof defaultsRaw.tracking_subdomain === "string" &&
    defaultsRaw.tracking_subdomain.trim()
      ? defaultsRaw.tracking_subdomain.trim()
      : "link";
  const returnpathDefault =
    typeof defaultsRaw.returnpath_subdomain === "string" &&
    defaultsRaw.returnpath_subdomain.trim()
      ? defaultsRaw.returnpath_subdomain.trim()
      : null;
  const autoVerify = defaultsRaw.auto_verify === true;

  /** @type {ConfigSenderDomain[]} */
  const senderDomains = [];
  const list = Array.isArray(cfg.sender_domains) ? cfg.sender_domains : [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const domain = typeof raw.domain === "string" ? raw.domain.trim().toLowerCase() : "";
    if (!id || !domain) continue;

    const spfVariant =
      raw.spf_variant === "mailcow" ? "mailcow" : raw.spf_variant === "default" ? "default" : null;

    senderDomains.push({
      id,
      domain,
      managed: raw.managed === true,
      tracking_subdomain:
        typeof raw.tracking_subdomain === "string" && raw.tracking_subdomain.trim()
          ? raw.tracking_subdomain.trim()
          : null,
      returnpath_subdomain:
        typeof raw.returnpath_subdomain === "string" && raw.returnpath_subdomain.trim()
          ? raw.returnpath_subdomain.trim()
          : null,
      notes: typeof raw.notes === "string" ? raw.notes.trim() || null : null,
      dmarc: typeof raw.dmarc === "string" ? raw.dmarc.trim() || null : null,
      spf: typeof raw.spf === "string" ? raw.spf.trim() || null : null,
      spf_variant: spfVariant,
    });
  }

  const domainsById = new Map(senderDomains.map((d) => [d.id, d]));
  const domainsByFqdn = new Map(senderDomains.map((d) => [d.domain, d]));

  const ipAllowRaw = isObject(cfg.ip_allow_list) ? cfg.ip_allow_list : {};
  /** @type {ConfigIpAllowListEntry[]} */
  const ipEntries = [];
  const ipList = Array.isArray(ipAllowRaw.entries) ? ipAllowRaw.entries : [];
  for (const raw of ipList) {
    if (!isObject(raw)) continue;
    const ip =
      typeof raw.ip_address === "string" ? normalizeIpAddress(raw.ip_address) : "";
    if (!ip) continue;
    ipEntries.push({
      ip_address: ip,
      description:
        typeof raw.description === "string" ? raw.description.trim() || null : null,
    });
  }
  ipEntries.sort((a, b) => a.ip_address.localeCompare(b.ip_address));

  const ipAllowList = {
    managed: ipAllowRaw.managed === true,
    enabled: ipAllowRaw.enabled === true,
    entries: ipEntries,
  };

  const allowedRaw = isObject(cfg.allowed_senders) ? cfg.allowed_senders : {};
  const allowedMode =
    allowedRaw.mode === "whitelist" || allowedRaw.mode === "blacklist"
      ? allowedRaw.mode
      : "disabled";
  /** @type {string[]} */
  const allowedSendersList = [];
  const sendersRaw = Array.isArray(allowedRaw.senders) ? allowedRaw.senders : [];
  for (const raw of sendersRaw) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (s) allowedSendersList.push(s);
  }
  allowedSendersList.sort((a, b) =>
    normalizeAllowedSender(a).localeCompare(normalizeAllowedSender(b))
  );

  const allowedSenders = {
    managed: allowedRaw.managed === true,
    mode: /** @type {AllowedSendersMode} */ (allowedMode),
    senders: allowedSendersList,
  };

  return {
    apiBase,
    apiKeyVaultKey,
    defaults: {
      tracking_subdomain: trackingDefault,
      returnpath_subdomain: returnpathDefault,
      auto_verify: autoVerify,
    },
    senderDomains,
    domainsById,
    domainsByFqdn,
    ipAllowList,
    allowedSenders,
  };
}

/**
 * @param {ConfigSenderDomain} entry
 * @param {import('./smtp2go-api.mjs').Smtp2goSenderDomainRow | null} live
 */
export function domainPresenceDrift(entry, live) {
  if (!live) return { missing_in_live: true, extra_in_config: false };
  return { missing_in_live: false, extra_in_config: false };
}

/**
 * @param {ConfigSenderDomain} entry
 * @param {import('./smtp2go-api.mjs').Smtp2goSenderDomainRow} live
 */
export function domainSettingsDrift(entry, live) {
  const tracker = Array.isArray(live.trackers)
    ? live.trackers.find((t) => t.enabled !== false)
    : null;
  const liveTracking =
    tracker && typeof tracker.subdomain === "string" ? tracker.subdomain.trim() : null;
  const configTracking = entry.tracking_subdomain;
  if (configTracking && liveTracking && configTracking !== liveTracking) {
    return true;
  }
  const liveRpath =
    typeof live.domain?.rpath_selector === "string" ? live.domain.rpath_selector.trim() : null;
  const configRpath = entry.returnpath_subdomain;
  if (configRpath && liveRpath && configRpath !== liveRpath) {
    return true;
  }
  return false;
}

/**
 * Resolve tracking/returnpath for domain/add from config entry + defaults.
 * @param {ConfigSenderDomain} entry
 * @param {ReturnType<typeof normalizeSmtp2goConfig>["defaults"]} defaults
 */
export function resolveDomainAddOptions(entry, defaults) {
  return {
    trackingSubdomain: entry.tracking_subdomain ?? defaults.tracking_subdomain,
    returnpathSubdomain: entry.returnpath_subdomain ?? defaults.returnpath_subdomain ?? undefined,
    autoVerify: defaults.auto_verify,
  };
}
