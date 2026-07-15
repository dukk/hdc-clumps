/**
 * Render Postfix relay settings (no secrets in returned snippets).
 * Relay block matches SMTP2GO submission on port 587.
 */

/** Default upstream for SMTP2GO. */
export const SMTP2GO_RELAYHOST = "[mail.smtp2go.com]:587";

/**
 * Outbound relay + TLS + SASL (SMTP2GO and similar smarthosts).
 * @param {object} [opts]
 * @param {string} [opts.relayhost]
 * @param {string} [opts.tlsSecurityLevel]
 * @returns {string}
 */
export function renderRelayCfSnippet(opts = {}) {
  const relayhost = (opts.relayhost ?? SMTP2GO_RELAYHOST).trim();
  const tlsLevel = (opts.tlsSecurityLevel ?? "encrypt").trim();
  const lines = [
    "# hdc postfix-relay — outbound smarthost (SMTP2GO-style)",
    `relayhost = ${relayhost}`,
    "",
    "smtp_sasl_auth_enable = yes",
    "smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd",
    "smtp_sasl_security_options = noanonymous",
    "smtp_sasl_tls_security_options = noanonymous",
    "",
    "smtp_use_tls = yes",
    `smtp_tls_security_level = ${tlsLevel}`,
    "smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Local identity and who may relay through this host.
 * @param {object} opts
 * @param {string} opts.myhostname
 * @param {string} opts.myorigin
 * @param {string} opts.mynetworks
 * @param {string} [opts.inetInterfaces]
 * @returns {string}
 */
export function renderLocalCfSnippet(opts) {
  const lines = [
    "# hdc postfix-relay — local policy",
    `myhostname = ${opts.myhostname}`,
    `myorigin = ${opts.myorigin}`,
    `mynetworks = ${opts.mynetworks}`,
    `inet_interfaces = ${opts.inetInterfaces ?? "all"}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Domain nexthop overrides (avoid hairpin through SMTP2GO for local mail domains).
 * @param {{ domain: string, nexthop: string }[]} entries
 * @returns {string} Written to /etc/postfix/transport
 */
export function renderTransportMap(entries) {
  const lines = ["# hdc postfix-relay — domain transport overrides"];
  for (const e of entries ?? []) {
    const domain = typeof e?.domain === "string" ? e.domain.trim() : "";
    const nexthop = typeof e?.nexthop === "string" ? e.nexthop.trim() : "";
    if (!domain || !nexthop) continue;
    lines.push(`${domain}\t${nexthop}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {object} opts
 * @param {string} opts.relayhost
 * @param {string} [opts.tlsSecurityLevel]
 * @param {string} opts.myhostname
 * @param {string} opts.myorigin
 * @param {string} opts.mynetworks
 * @param {string} [opts.inetInterfaces]
 * @param {{ domain: string, nexthop: string }[]} [opts.transport]
 * @returns {string} Written to /etc/postfix/main.cf.d/hdc-relay.cf
 */
export function renderMainCfSnippet(opts) {
  let out = renderLocalCfSnippet(opts) + "\n" + renderRelayCfSnippet(opts);
  const transport = Array.isArray(opts.transport) ? opts.transport : [];
  if (transport.length) {
    out += "\n# hdc domain transport overrides\n";
    out += "transport_maps = hash:/etc/postfix/transport\n";
  }
  return out;
}

/**
 * One line for /etc/postfix/sasl_passwd; postmap creates sasl_passwd.db.
 * @param {string} relayhost e.g. [mail.smtp2go.com]:587
 * @param {string} username SMTP2GO username (often your SMTP2GO login)
 * @param {string} password SMTP2GO password or API key
 * @returns {string}
 */
export function renderSaslPasswd(relayhost, username, password) {
  const host = relayhost.trim();
  const user = username.trim();
  const pass = password.replace(/\n/g, "");
  return `${host}\t${user}:${pass}\n`;
}

/**
 * @param {string} relayhost
 */
export function relayhostForSaslMap(relayhost) {
  return relayhost.trim();
}

/**
 * Postfix satellite client: forward all mail to internal hdc relay (no SASL).
 * @param {object} opts
 * @param {string} opts.relayhost e.g. [192.0.2.60]
 * @param {string} opts.myhostname
 * @param {string} opts.myorigin
 * @param {string} [opts.inetInterfaces]
 * @returns {string} Written to /etc/postfix/main.cf.d/hdc-satellite.cf
 */
export function renderSatelliteCfSnippet(opts) {
  const relayhost = opts.relayhost.trim();
  const inetInterfaces = (opts.inetInterfaces ?? "loopback-only").trim();
  const lines = [
    "# hdc postfix-relay — satellite client (internal smarthost)",
    `myhostname = ${opts.myhostname}`,
    `myorigin = ${opts.myorigin}`,
    `relayhost = ${relayhost}`,
    `inet_interfaces = ${inetInterfaces}`,
    "mydestination =",
    "local_transport = error:local delivery disabled on satellite",
  ];
  return `${lines.join("\n")}\n`;
}
