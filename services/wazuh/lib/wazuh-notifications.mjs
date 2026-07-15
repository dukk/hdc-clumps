/**
 * OpenSearch Notifications plugin — SMTP sender + email channel for Wazuh dashboard alerts.
 */

const INDEXER_URL = "https://127.0.0.1:9200";
const NOTIFICATIONS_BASE = "/_plugins/_notifications/configs";

/**
 * @param {import("./wazuh-mail-config.mjs").WazuhMailSettings} mail
 */
export function buildSmtpAccountConfig(mail) {
  const { notifications } = mail;
  return {
    config_id: notifications.smtp_sender_id,
    config: {
      name: "HDC postfix-relay",
      description: "Managed by hdc",
      config_type: "smtp_account",
      is_enabled: true,
      smtp_account: {
        host: mail.smtp_server,
        port: mail.smtp_port,
        method: "none",
        from_address: mail.email_from,
      },
    },
  };
}

/**
 * @param {import("./wazuh-mail-config.mjs").WazuhMailSettings} mail
 */
export function buildEmailChannelConfig(mail) {
  const { notifications } = mail;
  return {
    config_id: notifications.email_channel_id,
    config: {
      name: notifications.channel_name,
      description: "Managed by hdc",
      config_type: "email",
      is_enabled: true,
      email: {
        email_account_id: notifications.smtp_sender_id,
        recipient_list: {
          recipient: [...mail.email_to],
        },
      },
    },
  };
}

/**
 * @param {unknown} live
 * @param {ReturnType<typeof buildSmtpAccountConfig>} desired
 */
export function smtpAccountDrifts(live, desired) {
  if (!live || typeof live !== "object") return true;
  const cfg = /** @type {Record<string, unknown>} */ (live);
  const smtp = cfg.smtp_account;
  if (!smtp || typeof smtp !== "object") return true;
  const s = /** @type {Record<string, unknown>} */ (smtp);
  const want = desired.config.smtp_account;
  return (
    s.host !== want.host ||
    s.port !== want.port ||
    s.method !== want.method ||
    s.from_address !== want.from_address
  );
}

/**
 * @param {unknown} live
 * @param {ReturnType<typeof buildEmailChannelConfig>} desired
 */
export function emailChannelDrifts(live, desired) {
  if (!live || typeof live !== "object") return true;
  const cfg = /** @type {Record<string, unknown>} */ (live);
  const email = cfg.email;
  if (!email || typeof email !== "object") return true;
  const e = /** @type {Record<string, unknown>} */ (email);
  const want = desired.config.email;
  const liveRecipients = normalizeRecipientList(e.recipient_list);
  const wantRecipients = normalizeRecipientList(want.recipient_list);
  if (liveRecipients.length !== wantRecipients.length) return true;
  const sortedLive = [...liveRecipients].sort();
  const sortedWant = [...wantRecipients].sort();
  return (
    e.email_account_id !== want.email_account_id ||
    sortedLive.some((v, i) => v !== sortedWant[i])
  );
}

/** @param {unknown} recipientList */
function normalizeRecipientList(recipientList) {
  if (!recipientList || typeof recipientList !== "object") return [];
  const rl = /** @type {Record<string, unknown>} */ (recipientList);
  const raw = rl.recipient;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

/**
 * Bash fragment: sync OpenSearch notification configs (expects WAZUH_API_PASSWORD).
 *
 * @param {import("./wazuh-mail-config.mjs").WazuhMailSettings} mailSettings
 */
export function buildWazuhNotificationsSyncBash(mailSettings) {
  const smtp = buildSmtpAccountConfig(mailSettings);
  const email = buildEmailChannelConfig(mailSettings);
  const payload = JSON.stringify({ smtp, email });
  return [
    'for i in $(seq 1 30); do curl -sk -u "admin:$WAZUH_API_PASSWORD" https://127.0.0.1:9200/ >/dev/null 2>&1 && break; sleep 5; done',
    `python3 - <<'PY'`,
    "import json",
    "import os",
    "import ssl",
    "import urllib.error",
    "import urllib.request",
    "",
    `payload = json.loads(${JSON.stringify(payload)})`,
    "api_pw = os.environ['WAZUH_API_PASSWORD']",
    `base = ${JSON.stringify(INDEXER_URL + NOTIFICATIONS_BASE)}`,
    "auth = ('admin', api_pw)",
    "ctx = ssl.create_default_context()",
    "ctx.check_hostname = False",
    "ctx.verify_mode = ssl.CERT_NONE",
    "",
    "def request(method, url, body=None):",
    "  data = None if body is None else json.dumps(body).encode('utf-8')",
    "  headers = {'Content-Type': 'application/json'} if body is not None else {}",
    "  req = urllib.request.Request(url, data=data, headers=headers, method=method)",
    "  with urllib.request.urlopen(req, context=ctx) as resp:",
    "    raw = resp.read().decode('utf-8')",
    "    return json.loads(raw) if raw.strip() else {}",
    "",
    "def get_config(config_id):",
    "  url = f'{base}/{config_id}'",
    "  try:",
    "    return request('GET', url)",
    "  except urllib.error.HTTPError as e:",
    "    if e.code == 404:",
    "      return None",
    "    if e.code == 401:",
    "      print('notifications sync skipped: indexer returned 401 (check HDC_WAZUH_API_PASSWORD)')",
    "      raise SystemExit(0)",
    "    raise",
    "",
    "def smtp_drifts(live, desired):",
    "  if not live:",
    "    return True",
    "  cfg = live.get('config') or live",
    "  smtp = cfg.get('smtp_account') or {}",
    "  want = desired['config']['smtp_account']",
    "  return any(smtp.get(k) != want.get(k) for k in ('host', 'port', 'method', 'from_address'))",
    "",
    "def email_drifts(live, desired):",
    "  if not live:",
    "    return True",
    "  cfg = live.get('config') or live",
    "  email = cfg.get('email') or {}",
    "  want = desired['config']['email']",
    "  live_r = sorted((email.get('recipient_list') or {}).get('recipient') or [])",
    "  want_r = sorted((want.get('recipient_list') or {}).get('recipient') or [])",
    "  return email.get('email_account_id') != want.get('email_account_id') or live_r != want_r",
    "",
    "def upsert(desired, drifts_fn):",
    "  config_id = desired['config_id']",
    "  live = get_config(config_id)",
    "  if live is None:",
    "    request('POST', base, desired)",
    "    print(f'created notification config {config_id}')",
    "    return",
    "  if drifts_fn(live, desired):",
    "    request('PUT', f'{base}/{config_id}', desired)",
    "    print(f'updated notification config {config_id}')",
    "  else:",
    "    print(f'notification config {config_id} ok')",
    "",
    "upsert(payload['smtp'], smtp_drifts)",
    "upsert(payload['email'], email_drifts)",
    "",
    "try:",
    "  request('POST', f\"{base}/{payload['smtp']['config_id']}/_test\", {})",
    "  print('smtp sender test ok')",
    "except Exception as e:",
    "  print(f'smtp sender test skipped or failed: {e}')",
    "PY",
  ].join("\n");
}
