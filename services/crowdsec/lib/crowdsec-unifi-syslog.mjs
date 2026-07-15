/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const DEFAULT_LISTEN_PORT = 4242;
const DEFAULT_ALLOWED_SENDERS = ["10.0.0.1/32"];

/**
 * @param {unknown} crowdsec
 */
export function crowdsecUnifiSyslogConfig(crowdsec) {
  if (!isObject(crowdsec)) return null;
  const unifi = isObject(crowdsec.unifi) ? crowdsec.unifi : null;
  const syslog = unifi && isObject(unifi.syslog) ? unifi.syslog : null;
  if (!syslog || syslog.enabled === false || syslog.enabled === 0) return null;

  const portRaw = syslog.listen_port;
  const port = typeof portRaw === "number" ? portRaw : Number(portRaw);
  const listenPort = Number.isFinite(port) && port > 0 && port <= 65535 ? port : DEFAULT_LISTEN_PORT;

  const sendersRaw = Array.isArray(syslog.allowed_senders) ? syslog.allowed_senders : DEFAULT_ALLOWED_SENDERS;
  const allowedSenders = sendersRaw
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim());
  const cefSplit = syslog.cef_split !== false && syslog.cef_split !== 0;

  return {
    enabled: true,
    listen_port: listenPort,
    allowed_senders: allowedSenders.length ? allowedSenders : DEFAULT_ALLOWED_SENDERS,
    cef_split: cefSplit,
  };
}

/**
 * @param {{ listen_port: number; allowed_senders: string[]; cef_split: boolean }} cfg
 */
export function buildUnifiSyslogSetupScript(cfg) {
  const senders = cfg.allowed_senders.map((s) => s.replace(/"/g, '\\"')).join(", ");
  const port = cfg.listen_port;
  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq rsyslog",
    "mkdir -p /var/log",
    "touch /var/log/unifi-cef.log /var/log/unifi-syslog.log",
    "chmod 644 /var/log/unifi-cef.log /var/log/unifi-syslog.log",
  ];

  if (cfg.cef_split) {
    lines.push(
      `cat > /etc/rsyslog.d/unifi-cef.conf <<'RSYSLOG'`,
      'module(load="imudp")',
      `$AllowedSender UDP, ${senders}`,
      'template(name="CEF" type="string" string="%msg%\\n")',
      'template(name="Syslog" type="string" string="%timegenerated% %hostname% %programname%[%procid%]: %msg%\\n")',
      "input(",
      '  type="imudp"',
      '  name="unifi_in"',
      `  port="${port}"`,
      '  ruleset="unifi"',
      ")",
      'ruleset(name="unifi") {',
      '    if $rawmsg startswith "CEF:" then {',
      '        action(type="omfile" file="/var/log/unifi-cef.log" template="CEF")',
      "    } else {",
      '        action(type="omfile" file="/var/log/unifi-syslog.log" template="Syslog")',
      "    }",
      "    stop",
      "}",
      "RSYSLOG",
    );
  } else {
    lines.push(
      `cat > /etc/rsyslog.d/unifi-cef.conf <<'RSYSLOG'`,
      'module(load="imudp")',
      `$AllowedSender UDP, ${senders}`,
      "input(",
      '  type="imudp"',
      '  name="unifi_in"',
      `  port="${port}"`,
      '  ruleset="unifi"',
      ")",
      'ruleset(name="unifi") {',
      '    action(type="omfile" file="/var/log/unifi-syslog.log" template="RSYSLOG_TraditionalFileFormat")',
      "    stop",
      "}",
      "RSYSLOG",
    );
  }

  lines.push(
    `cat > /etc/logrotate.d/unifi <<'LOGROTATE'`,
    "/var/log/unifi-cef.log /var/log/unifi-syslog.log {",
    "    daily",
    "    rotate 7",
    "    compress",
    "    delaycompress",
    "    missingok",
    "    notifempty",
    "    postrotate",
    "        systemctl reload rsyslog >/dev/null 2>&1 || true",
    "    endscript",
    "}",
    "LOGROTATE",
    "mkdir -p /etc/crowdsec/acquis.d",
  );

  if (cfg.cef_split) {
    lines.push(
      `cat > /etc/crowdsec/acquis.d/unifi-cef.yaml <<'ACQ'`,
      "---",
      "filenames:",
      "  - /var/log/unifi-cef.log",
      "labels:",
      "  type: cef",
      "ACQ",
    );
  }

  lines.push(
    `cat > /etc/crowdsec/acquis.d/unifi-syslog.yaml <<'ACQ'`,
    "---",
    "filenames:",
    "  - /var/log/unifi-syslog.log",
    "labels:",
    "  type: unifi",
    "ACQ",
    "systemctl enable rsyslog 2>/dev/null || true",
    "systemctl restart rsyslog",
    "systemctl restart crowdsec 2>/dev/null || true",
    `ss -uln | grep -q ':${port} ' || netstat -uln 2>/dev/null | grep -q ':${port} ' || true`,
  );

  return lines.join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {import("../../../lib/pve-pct-remote.mjs").pctExec} pctExec
 * @param {Record<string, unknown>} crowdsec
 */
export function installUnifiSyslogInCt(user, pveHost, vmid, pctExec, crowdsec) {
  const cfg = crowdsecUnifiSyslogConfig(crowdsec);
  if (!cfg) {
    return { ok: true, skipped: true, message: "unifi syslog not enabled" };
  }
  const inner = buildUnifiSyslogSetupScript(cfg);
  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `unifi syslog setup failed (exit ${r.status})`,
      stderr: r.stderr?.slice(0, 800),
    };
  }
  return { ok: true, skipped: false, message: "unifi syslog configured", ...cfg };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {import("../../../lib/pve-pct-remote.mjs").pctExec} pctExec
 */
export function queryUnifiSyslogInCt(user, pveHost, vmid, pctExec) {
  const portProbe = pctExec(
    user,
    pveHost,
    vmid,
    "ss -uln 2>/dev/null | awk '{print $2}' | grep -E ':424[0-9]$' | head -1 || true",
    { capture: true },
  );
  const cefLines = pctExec(user, pveHost, vmid, "wc -l < /var/log/unifi-cef.log 2>/dev/null || echo 0", {
    capture: true,
  });
  const syslogLines = pctExec(user, pveHost, vmid, "wc -l < /var/log/unifi-syslog.log 2>/dev/null || echo 0", {
    capture: true,
  });
  const rsyslog = pctExec(user, pveHost, vmid, "systemctl is-active rsyslog 2>/dev/null || echo inactive", {
    capture: true,
  });
  return {
    rsyslog_active: rsyslog.stdout.trim(),
    udp_listen: portProbe.stdout.trim() || null,
    unifi_cef_log_lines: Number(cefLines.stdout.trim()) || 0,
    unifi_syslog_log_lines: Number(syslogLines.stdout.trim()) || 0,
  };
}
