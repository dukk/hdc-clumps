import {
  accessNodesFromSystem,
  loadManualSystemSidecar,
} from "hdc/package/inventory-sidecar.mjs";

/** Default nginx-waf inventory system ids (HA pair). */
export const DEFAULT_NGINX_WAF_SYSTEM_IDS = ["vm-nginx-waf-a", "vm-nginx-waf-b"];

/**
 * @param {string} ip
 */
function normalizeLanIp(ip) {
  const raw = String(ip ?? "").trim();
  if (!raw) return null;
  return raw.split("/")[0].trim() || null;
}

/**
 * Resolve nginx-waf LAN IPs for Home Assistant `trusted_proxies` from inventory sidecars.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {string[]} [opts.systemIds]
 * @param {string[]} [opts.overrideIps] Explicit IPs/CIDRs from clump config (wins when non-empty)
 * @returns {string[]}
 */
export function resolveNginxWafTrustedProxies(repoRoot, opts = {}) {
  const override = Array.isArray(opts.overrideIps)
    ? opts.overrideIps.map((v) => String(v).trim()).filter(Boolean)
    : [];
  if (override.length) return [...new Set(override)];

  const systemIds = Array.isArray(opts.systemIds) && opts.systemIds.length
    ? opts.systemIds.map((v) => String(v).trim()).filter(Boolean)
    : DEFAULT_NGINX_WAF_SYSTEM_IDS;

  /** @type {string[]} */
  const ips = [];
  for (const systemId of systemIds) {
    const sidecar = loadManualSystemSidecar(repoRoot, systemId);
    if (!sidecar) continue;
    for (const node of accessNodesFromSystem(sidecar)) {
      const ip = normalizeLanIp(node.ip);
      if (ip && !ips.includes(ip)) ips.push(ip);
    }
  }
  return ips;
}
