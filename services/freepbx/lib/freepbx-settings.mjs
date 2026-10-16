/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} twilio
 * @param {{ username: string; password: string }} secrets
 */
export function buildPjsipTrunkSettings(twilio, secrets) {
  const t = isObject(twilio) ? twilio : {};
  const name = typeof t.trunk_name === "string" && t.trunk_name.trim() ? t.trunk_name.trim() : "twilio0";
  const server =
    typeof t.termination_domain === "string" ? t.termination_domain.trim() : "";
  const proxyRaw = typeof t.outbound_proxy === "string" ? t.outbound_proxy.trim() : "";
  const proxy = proxyRaw && !proxyRaw.includes(":") ? `sip:${proxyRaw}` : proxyRaw;
  const cidrs = Array.isArray(t.identify_cidrs)
    ? t.identify_cidrs.map((c) => String(c).trim()).filter(Boolean)
    : [];
  return {
    trunk_name: name,
    username: secrets.username,
    auth_username: secrets.username,
    secret: secrets.password,
    authentication: "outbound",
    registration: "send",
    sip_server: server,
    sip_server_port: "5060",
    context: "from-pstn",
    transport: "0.0.0.0-udp",
    dtmfmode: "auto",
    outbound_proxy: proxy,
    from_domain: server,
    match: cidrs.join(","),
    identify_by: "default",
    direct_media: "no",
    rtp_symmetric: "yes",
    force_rport: "yes",
    rewrite_contact: "no",
    sendrpid: "no",
    trust_id_outbound: "no",
    media_encryption: "no",
    qualify_frequency: "60",
    expiration: "3600",
    retry_interval: "60",
    fatal_retry_interval: "0",
    forbidden_retry_interval: "30",
    max_retries: "10000",
    auth_rejection_permanent: "off",
  };
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.freepbx
 * @param {string} opts.adminPassword
 * @param {string} opts.sipUsername
 * @param {string} opts.sipPassword
 */
export function buildApplyPayload(opts) {
  const fp = opts.freepbx;
  const nat = isObject(fp.nat) ? fp.nat : {};
  const twilio = isObject(fp.twilio) ? fp.twilio : {};
  const twilioEnabled = twilio.enabled !== false;
  const dialPrefix =
    typeof twilio.dial_prefix === "string" && twilio.dial_prefix.trim()
      ? twilio.dial_prefix.trim()
      : "9";
  const routeName =
    typeof twilio.route_name === "string" && twilio.route_name.trim()
      ? twilio.route_name.trim()
      : "twilio-out";
  const trunkName =
    typeof twilio.trunk_name === "string" && twilio.trunk_name.trim()
      ? twilio.trunk_name.trim()
      : "twilio0";
  return {
    admin_user: typeof fp.admin_user === "string" && fp.admin_user.trim() ? fp.admin_user.trim() : "admin",
    admin_password: opts.adminPassword,
    rtp_port_min: Number(fp.rtp_port_min) || 10000,
    rtp_port_max: Number(fp.rtp_port_max) || 12499,
    externip: typeof nat.external_address === "string" ? nat.external_address.trim() : "",
    local_net: typeof nat.local_net === "string" ? nat.local_net.trim() : "",
    twilio_enabled: twilioEnabled,
    trunk_name: trunkName,
    route_name: routeName,
    dial_prefix: dialPrefix,
    pjsip: twilioEnabled
      ? buildPjsipTrunkSettings(twilio, {
          username: opts.sipUsername,
          password: opts.sipPassword,
        })
      : null,
  };
}
