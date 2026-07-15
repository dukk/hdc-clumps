/** Default Twilio signaling IP ranges (verify against current Twilio docs). */
export const DEFAULT_TWILIO_IDENTIFY_CIDRS = [
  "54.172.60.0/23",
  "54.244.51.0/24",
  "54.171.127.192/26",
  "35.156.191.128/25",
  "35.171.247.128/25",
];

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} global
 * @param {Record<string, unknown>} [deployment]
 */
export function mergeAsteriskSettings(global, deployment = {}) {
  const base = isObject(global) ? structuredClone(global) : {};
  const local = isObject(deployment.asterisk) ? deployment.asterisk : {};
  if (!Object.keys(local).length) return base;
  return deepMerge(base, local);
}

/**
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
function deepMerge(target, source) {
  for (const [key, val] of Object.entries(source)) {
    if (isObject(val) && isObject(target[key])) {
      deepMerge(/** @type {Record<string, unknown>} */ (target[key]), val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

/**
 * @param {Record<string, unknown>} asterisk
 */
export function sipPort(asterisk) {
  const p = typeof asterisk.sip_port === "number" ? asterisk.sip_port : Number(asterisk.sip_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 5060;
}

/**
 * @param {Record<string, unknown>} asterisk
 */
export function sipTransport(asterisk) {
  const t = typeof asterisk.sip_transport === "string" ? asterisk.sip_transport.trim() : "";
  return t || "udp";
}

/**
 * @param {Record<string, unknown>} asterisk
 */
export function rtpPortRange(asterisk) {
  const min =
    typeof asterisk.rtp_port_min === "number"
      ? asterisk.rtp_port_min
      : Number(asterisk.rtp_port_min);
  const max =
    typeof asterisk.rtp_port_max === "number"
      ? asterisk.rtp_port_max
      : Number(asterisk.rtp_port_max);
  return {
    min: Number.isFinite(min) ? Math.floor(min) : 10000,
    max: Number.isFinite(max) ? Math.floor(max) : 20000,
  };
}

/**
 * @param {Record<string, unknown>} asterisk
 */
export function twilioBlock(asterisk) {
  return isObject(asterisk.twilio) ? asterisk.twilio : {};
}

/**
 * @param {Record<string, unknown>} asterisk
 */
export function twilioEnabled(asterisk) {
  const tw = twilioBlock(asterisk);
  return tw.enabled !== false;
}

/**
 * @param {Record<string, unknown>} twilio
 */
export function twilioTrunkName(twilio) {
  const n = typeof twilio.trunk_name === "string" ? twilio.trunk_name.trim() : "";
  return n || "twilio0";
}

/**
 * @param {Record<string, unknown>} twilio
 */
export function twilioCredentialUsernameVaultKey(twilio) {
  const k =
    typeof twilio.credential_username_vault_key === "string" &&
    twilio.credential_username_vault_key.trim()
      ? twilio.credential_username_vault_key.trim()
      : "HDC_TWILIO_SIP_USERNAME";
  return k;
}

/**
 * @param {Record<string, unknown>} twilio
 */
export function twilioCredentialPasswordVaultKey(twilio) {
  const k =
    typeof twilio.credential_password_vault_key === "string" &&
    twilio.credential_password_vault_key.trim()
      ? twilio.credential_password_vault_key.trim()
      : "HDC_TWILIO_SIP_PASSWORD";
  return k;
}

/**
 * @param {Record<string, unknown>} twilio
 */
export function twilioIdentifyCidrs(twilio) {
  if (Array.isArray(twilio.identify_cidrs) && twilio.identify_cidrs.length > 0) {
    return twilio.identify_cidrs
      .filter((c) => typeof c === "string" && c.trim())
      .map((c) => String(c).trim());
  }
  return [...DEFAULT_TWILIO_IDENTIFY_CIDRS];
}

/**
 * @param {Record<string, unknown>} asterisk
 */
export function natBlock(asterisk) {
  return isObject(asterisk.nat) ? asterisk.nat : {};
}

/**
 * @param {Record<string, unknown>} asterisk
 */
export function endpointList(asterisk) {
  if (!Array.isArray(asterisk.endpoints)) return [];
  return asterisk.endpoints.filter(isObject);
}

/**
 * @param {Record<string, unknown>} asterisk
 * @param {string} sipPortNum
 */
export function renderTransportConf(asterisk, sipPortNum) {
  const transport = sipTransport(asterisk);
  const nat = natBlock(asterisk);
  const lines = [
    "; HDC Asterisk — generated transport (do not edit on server)",
    "",
  ];

  if (transport.includes("udp")) {
    lines.push("[transport-udp]");
    lines.push("type=transport");
    lines.push("protocol=udp");
    lines.push(`bind=0.0.0.0:${sipPortNum}`);
    if (nat.enabled !== false) {
      const localNet = typeof nat.local_net === "string" ? nat.local_net.trim() : "";
      const extSig =
        typeof nat.external_signaling_address === "string"
          ? nat.external_signaling_address.trim()
          : "";
      const extMedia =
        typeof nat.external_media_address === "string" ? nat.external_media_address.trim() : "";
      if (localNet) lines.push(`local_net=${localNet}`);
      if (extSig) lines.push(`external_signaling_address=${extSig}`);
      if (extMedia) lines.push(`external_media_address=${extMedia}`);
    }
    lines.push("");
  }

  if (transport.includes("tcp")) {
    lines.push("[transport-tcp]");
    lines.push("type=transport");
    lines.push("protocol=tcp");
    lines.push(`bind=0.0.0.0:${sipPortNum}`);
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

/**
 * @param {Record<string, unknown>} asterisk
 * @param {{ username: string; password: string }} creds
 */
export function renderTwilioTrunkConf(asterisk, creds) {
  const tw = twilioBlock(asterisk);
  if (!twilioEnabled(asterisk)) {
    return "; HDC Asterisk — Twilio trunk disabled\n";
  }

  const trunk = twilioTrunkName(tw);
  const domain =
    typeof tw.termination_domain === "string" ? tw.termination_domain.trim() : "";
  if (!domain) {
    throw new Error("asterisk.twilio.termination_domain required when twilio.enabled");
  }

  const outboundProxy =
    typeof tw.outbound_proxy === "string" ? tw.outbound_proxy.trim() : "";
  const cidrs = twilioIdentifyCidrs(tw);
  const lines = [
    "; HDC Asterisk — Twilio Elastic SIP Trunk (do not edit on server)",
    "",
    `[${trunk}-endpoint]`,
    "type=endpoint",
    "transport=transport-udp",
    `context=${originationContext(tw)}`,
    "disallow=all",
    "allow=ulaw,alaw",
    `aors=${trunk}-aor`,
    `outbound_auth=${trunk}-auth`,
    `from_domain=${domain}`,
  ];
  if (outboundProxy) {
    lines.push(`outbound_proxy=sip:${outboundProxy}`);
  }
  lines.push(
    "",
    `[${trunk}-aor]`,
    "type=aor",
    `contact=sip:${domain}`,
    "",
    `[${trunk}-auth]`,
    "type=auth",
    "auth_type=userpass",
    `username=${creds.username}`,
    `password=${creds.password}`,
    "",
    `[${trunk}-identify]`,
    "type=identify",
    `endpoint=${trunk}-endpoint`,
  );
  for (const cidr of cidrs) {
    lines.push(`match=${cidr}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} twilio
 */
function originationContext(twilio) {
  const orig = isObject(twilio.origination) ? twilio.origination : {};
  const ctx = typeof orig.context === "string" ? orig.context.trim() : "";
  return ctx || "from-twilio";
}

/**
 * @param {Record<string, unknown>} twilio
 */
function terminationContext(twilio) {
  const term = isObject(twilio.termination) ? twilio.termination : {};
  const ctx = typeof term.context === "string" ? term.context.trim() : "";
  return ctx || "outbound-twilio";
}

/**
 * @param {Record<string, unknown>} twilio
 */
function dialPrefix(twilio) {
  const term = isObject(twilio.termination) ? twilio.termination : {};
  const p = typeof term.dial_prefix === "string" ? term.dial_prefix : "9";
  return p || "9";
}

/**
 * @param {Record<string, unknown>} asterisk
 * @param {{ endpointPasswords: Record<string, string> }} secrets
 */
export function renderEndpointsConf(asterisk, secrets) {
  const endpoints = endpointList(asterisk);
  if (!endpoints.length) {
    return "; HDC Asterisk — no internal endpoints configured\n";
  }

  const lines = ["; HDC Asterisk — internal PJSIP endpoints (do not edit on server)", ""];
  for (const ep of endpoints) {
    const id = typeof ep.id === "string" ? ep.id.trim() : "";
    if (!id) continue;
    const ctx = typeof ep.context === "string" ? ep.context.trim() : "from-internal";
    const pwKey =
      typeof ep.auth_username_vault_key === "string"
        ? ep.auth_username_vault_key.trim()
        : `HDC_ASTERISK_EXT_${id}_PASSWORD`;
    const password = secrets.endpointPasswords[pwKey] ?? secrets.endpointPasswords[id] ?? "";
    lines.push(
      `[${id}]`,
      "type=endpoint",
      "transport=transport-udp",
      `context=${ctx}`,
      "disallow=all",
      "allow=ulaw,alaw",
      `auth=${id}-auth`,
      `aors=${id}`,
      "",
      `[${id}-auth]`,
      "type=auth",
      "auth_type=userpass",
      `username=${id}`,
      `password=${password || "CHANGE_ME"}`,
      "",
      `[${id}-aor]`,
      "type=aor",
      "max_contacts=5",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} asterisk
 */
export function renderTwilioDialplanConf(asterisk) {
  const tw = twilioBlock(asterisk);
  if (!twilioEnabled(asterisk)) {
    return "; HDC Asterisk — Twilio dialplan disabled\n";
  }

  const trunk = twilioTrunkName(tw);
  const inCtx = originationContext(tw);
  const outCtx = terminationContext(tw);
  const prefix = dialPrefix(tw);
  const endpoints = endpointList(asterisk);
  const firstEndpoint = endpoints.find((e) => typeof e.id === "string" && e.id.trim());
  const endpointId = firstEndpoint && typeof firstEndpoint.id === "string" ? firstEndpoint.id.trim() : null;

  const lines = [
    "; HDC Asterisk — Twilio dialplan (do not edit on server)",
    "",
    `[${inCtx}]`,
    "exten => s,1,NoOp(Inbound from Twilio)",
  ];
  if (endpointId) {
    lines.push(` same => n,Dial(PJSIP/${endpointId},30)`);
    lines.push(" same => n,Hangup()");
  } else {
    lines.push(" same => n,Answer()");
    lines.push(' same => n,Playback(demo-congrats)');
    lines.push(" same => n,Hangup()");
  }
  lines.push(
    `exten => _+1NXXNXXXXXX,1,NoOp(Inbound E.164 from Twilio: \${EXTEN})`,
  );
  if (endpointId) {
    lines.push(` same => n,Dial(PJSIP/${endpointId},30)`);
  } else {
    lines.push(" same => n,Answer()");
    lines.push(' same => n,Playback(demo-congrats)');
  }
  lines.push(" same => n,Hangup()", "");

  const term = isObject(tw.termination) ? tw.termination : {};
  if (term.enabled !== false) {
    lines.push(
      `[${outCtx}]`,
      `exten => _${prefix}.,1,NoOp(Outbound via Twilio trunk)`,
      ` same => n,Set(NUM=\${EXTEN:${prefix.length}})`,
      ` same => n,Dial(PJSIP/+\${NUM}@${trunk}-endpoint,60)`,
      " same => n,Hangup()",
      "",
      "[from-internal]",
      `include => ${outCtx}`,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} asterisk
 */
export function renderRtpConf(asterisk) {
  const { min, max } = rtpPortRange(asterisk);
  return [
    "; HDC Asterisk — RTP port range (do not edit on server)",
    "[general]",
    `rtpstart=${min}`,
    `rtpend=${max}`,
    "",
  ].join("\n");
}

/**
 * @param {Record<string, unknown>} asterisk
 * @param {{ username: string; password: string; endpointPasswords: Record<string, string> }} secrets
 */
export function renderAllConfigFiles(asterisk, secrets) {
  const port = sipPort(asterisk);
  return {
    "pjsip.d/hdc-transport.conf": renderTransportConf(asterisk, port),
    "pjsip.d/hdc-twilio-trunk.conf": renderTwilioTrunkConf(asterisk, {
      username: secrets.username,
      password: secrets.password,
    }),
    "pjsip.d/hdc-endpoints.conf": renderEndpointsConf(asterisk, secrets),
    "extensions.d/hdc-twilio-dialplan.conf": renderTwilioDialplanConf(asterisk),
    "rtp.d/hdc-rtp.conf": renderRtpConf(asterisk),
  };
}

/**
 * Shell script to ensure include directories exist in main configs.
 * @returns {string}
 */
export function buildEnsureIncludesScript() {
  return [
    "set -euo pipefail",
    "mkdir -p /etc/asterisk/pjsip.d /etc/asterisk/extensions.d /etc/asterisk/rtp.d",
    'grep -q "pjsip.d" /etc/asterisk/pjsip.conf 2>/dev/null || echo "#include pjsip.d/*.conf" >> /etc/asterisk/pjsip.conf',
    'grep -q "extensions.d" /etc/asterisk/extensions.conf 2>/dev/null || echo "#include extensions.d/*.conf" >> /etc/asterisk/extensions.conf',
    'grep -q "rtp.d" /etc/asterisk/rtp.conf 2>/dev/null || echo "#include rtp.d/*.conf" >> /etc/asterisk/rtp.conf',
  ].join("\n");
}
