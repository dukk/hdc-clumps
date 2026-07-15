/** Pinned sdns stamps from DNSCrypt/dnscrypt-resolvers v3 (odoh-servers.md, odoh-relays.md). */
export const ODOH_STATIC_STAMPS = {
  "odoh-cloudflare": "sdns://BQcAAAAAAAAAF29kb2guY2xvdWRmbGFyZS1kbnMuY29tCi9kbnMtcXVlcnk",
  "odohrelay-crypto-sx": "sdns://hQcAAAAAAAAAAAAab2RvaC1yZWxheS5lZGdlY29tcHV0ZS5hcHABLw",
};

const MIN_DNSCRYPT_PROXY_VERSION = "2.0.46";

/**
 * @param {object} opts
 * @param {string} opts.listen e.g. 127.0.0.1:5300
 * @param {string} opts.server ODoH target static name (default odoh-cloudflare)
 * @param {string} opts.relay ODoH relay static name (default odohrelay-crypto-sx)
 */
export function renderDnscryptProxyToml(opts) {
  const listen = opts.listen.trim();
  const server = opts.server.trim();
  const relay = opts.relay.trim();
  const serverStamp = ODOH_STATIC_STAMPS[server];
  const relayStamp = ODOH_STATIC_STAMPS[relay];
  if (!serverStamp) {
    throw new Error(
      `Unknown ODoH server ${JSON.stringify(server)}; add stamp to ODOH_STATIC_STAMPS or use odoh-cloudflare`,
    );
  }
  if (!relayStamp) {
    throw new Error(
      `Unknown ODoH relay ${JSON.stringify(relay)}; add stamp to ODOH_STATIC_STAMPS or use odohrelay-crypto-sx`,
    );
  }

  return [
    "# hdc bind — dnscrypt-proxy (ODoH upstream for BIND forwarders)",
    `listen_addresses = ['${listen}']`,
    "max_clients = 256",
    "ipv6_servers = false",
    "dnscrypt_servers = false",
    "doh_servers = false",
    "odoh_servers = true",
    "require_dnssec = false",
    "require_nolog = false",
    "require_nofilter = false",
    "log_level = 2",
    `server_names = ['${server}']`,
    "",
    "[anonymized_dns]",
    "routes = [",
    `    { server_name='${server}', via=['${relay}'] }`,
    "]",
    "",
    "[static]",
    `[static.'${server}']`,
    `stamp = '${serverStamp}'`,
    "",
    `[static.'${relay}']`,
    `stamp = '${relayStamp}'`,
    "",
  ].join("\n");
}

export { MIN_DNSCRYPT_PROXY_VERSION };
