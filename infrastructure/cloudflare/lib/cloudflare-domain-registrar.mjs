/**
 * Cloudflare DomainRegistrar — list apex zones + RDAP expiry for inventory export.
 */
import { createCloudflareClient } from "./cloudflare-api.mjs";
import { zonePassesFilter } from "./cloudflare-config.mjs";

/**
 * @typedef {import('hdc/package/domain-registrar.mjs').DomainRecord} DomainRecord
 * @typedef {import('hdc/package/domain-registrar.mjs').DomainRegistrarLog} DomainRegistrarLog
 */

/**
 * @param {unknown} obj
 * @returns {string | null}
 */
export function pickRdapExpiry(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const events = /** @type {{ eventAction?: string; eventDate?: string }[]} */ (
    /** @type {Record<string, unknown>} */ (obj).events || []
  );
  if (!Array.isArray(events)) return null;
  const exp = events.find((e) => e && e.eventAction === "expiration");
  if (exp?.eventDate) return String(exp.eventDate);
  const alt = events.find((e) => e && /expir/i.test(String(e.eventAction || "")));
  if (alt?.eventDate) return String(alt.eventDate);
  return null;
}

/**
 * @param {unknown} obj
 * @returns {string | null}
 */
export function pickRdapRegistrarName(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const ents = /** @type {Record<string, unknown>[]} */ (
    /** @type {Record<string, unknown>} */ (obj).entities || []
  );
  if (!Array.isArray(ents)) return null;
  for (const e of ents) {
    const roles = Array.isArray(e.roles) ? e.roles.map(String) : [];
    if (!roles.includes("registrar")) continue;
    const vcard = e.vcardArray;
    if (Array.isArray(vcard) && Array.isArray(vcard[1])) {
      const fn = vcard[1].find((x) => Array.isArray(x) && x[0] === "fn");
      if (fn && fn[3] != null) return String(fn[3]);
    }
    if (e.handle) return String(e.handle);
  }
  return null;
}

/**
 * @param {string} apex
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ expires_at: string | null; registrar_name: string | null }>}
 */
export async function fetchRdapDomainMeta(apex, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const urls = [
    `https://rdap.org/domain/${encodeURIComponent(apex)}`,
    `https://rdap.cloudflare.com/rdap/v1/domain/${encodeURIComponent(apex)}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { Accept: "application/rdap+json, application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const body = await res.json();
      return {
        expires_at: pickRdapExpiry(body),
        registrar_name: pickRdapRegistrarName(body),
      };
    } catch {
      /* try next */
    }
  }
  return { expires_at: null, registrar_name: null };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createCloudflareClient>} opts.api
 * @param {ReturnType<import('./cloudflare-config.mjs').normalizeCloudflareConfig>} opts.config
 * @param {boolean} [opts.fetchExpiry]
 * @param {DomainRegistrarLog} [opts.log]
 * @returns {Promise<DomainRecord[]>}
 */
export async function listCloudflareDomainRecords(opts) {
  const { api, config, fetchExpiry = true, log } = opts;
  const allZones = await api.listZones();
  const filtered = allZones.filter((z) => zonePassesFilter(z.name, config.zoneFilter));
  /** @type {DomainRecord[]} */
  const out = [];

  for (const zone of filtered) {
    const apex = String(zone.name || "")
      .trim()
      .toLowerCase();
    if (!apex) continue;
    /** @type {DomainRecord} */
    const row = {
      apex,
      in_account: true,
      status: zone.status,
      zone_id: zone.id,
      expires_at: null,
      registrar_name: "Cloudflare, Inc.",
    };
    if (fetchExpiry) {
      log?.info?.(`RDAP ${apex}`);
      const meta = await fetchRdapDomainMeta(apex);
      row.expires_at = meta.expires_at;
      if (meta.registrar_name) row.registrar_name = meta.registrar_name;
    }
    out.push(row);
  }

  out.sort((a, b) => a.apex.localeCompare(b.apex));
  return out;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createCloudflareClient>} opts.api
 * @param {ReturnType<import('./cloudflare-config.mjs').normalizeCloudflareConfig>} opts.config
 * @param {boolean} [opts.fetchExpiry]
 * @returns {import('hdc/package/domain-registrar.mjs').DomainRegistrar}
 */
export function createCloudflareDomainRegistrar(opts) {
  const { api, config, fetchExpiry = true } = opts;
  return {
    backendId: "cloudflare",
    async listDomains(log) {
      return listCloudflareDomainRecords({ api, config, fetchExpiry, log });
    },
  };
}
