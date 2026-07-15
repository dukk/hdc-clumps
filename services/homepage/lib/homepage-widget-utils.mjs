/** @param {unknown} v */
export function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} ipConfig
 * @returns {string | null}
 */
export function ipFromIpConfig(ipConfig) {
  const raw = typeof ipConfig === "string" ? ipConfig.trim() : "";
  if (!raw || /^dhcp$/i.test(raw)) return null;
  const addrPart = raw.split(",")[0]?.trim() ?? "";
  const ip = addrPart.split("/")[0]?.trim() ?? "";
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  return ip;
}

/**
 * @param {string} cidr
 * @returns {string | null}
 */
export function ipFromCidr(cidr) {
  return ipFromIpConfig(cidr);
}

/**
 * @param {Record<string, unknown>} homepage
 * @param {string} configKey
 */
export function widgetBlockEnabled(homepage, configKey) {
  const widget = homepage[configKey];
  if (!isObject(widget)) return false;
  return widget.enabled !== false && widget.enabled !== 0;
}

/**
 * Prefer HTTPS public_url from service config; fall back to direct guest IP:port.
 * @param {string | undefined | null} publicUrl
 * @param {string} host
 * @param {number} port
 * @param {"http" | "https"} [scheme]
 */
export function serviceUrlFromPublicUrlOrHostPort(publicUrl, host, port, scheme = "http") {
  const url = typeof publicUrl === "string" ? publicUrl.trim() : "";
  if (url) return url;
  return serviceUrlFromHostPort(host, port, scheme);
}

/**
 * @param {string} host
 * @param {number} port
 * @param {"http" | "https"} [scheme]
 */
export function serviceUrlFromHostPort(host, port, scheme = "http") {
  const h = typeof host === "string" ? host.trim() : "";
  const p = Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.floor(port) : null;
  if (!h || p === null) return null;
  return `${scheme}://${h}:${p}`;
}

/**
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 * @param {string} vaultKey
 * @param {string} hint
 */
export async function readRequiredVaultSecret(vaultAccess, vaultKey, hint) {
  await vaultAccess.unlock({});
  const data = (await vaultAccess.readSecrets({})) ?? {};
  const val = typeof data[vaultKey] === "string" ? data[vaultKey].trim() : "";
  if (!val) {
    throw new Error(`${hint} — run: node apps/hdc-cli/cli.mjs secrets set ${vaultKey}`);
  }
  return val;
}

/**
 * @param {Record<string, unknown>} widget
 * @param {string} key
 * @param {string} fallback
 */
export function vaultKeyFromWidget(widget, key, fallback) {
  const val = typeof widget[key] === "string" ? widget[key].trim() : "";
  return val || fallback;
}
