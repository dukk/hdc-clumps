import { flagGet } from "hdc/package/parse-argv-flags.mjs";

/**
 * @param {Record<string, string>} [flags]
 */
export function wazuhDashboardMonitorsSkippedByFlags(flags) {
  return flagGet(flags ?? {}, "skip-dashboard-monitors", "skip_dashboard_monitors") !== undefined;
}

/**
 * Bash fragment: ensure OpenSearch Alerting monitors route to the hdc-wazuh-alerts channel.
 * Expects WAZUH_API_PASSWORD and runs inside the Wazuh stack directory (STACK).
 *
 * @param {import("./wazuh-mail-config.mjs").WazuhMailSettings} mailSettings
 */
export function buildWazuhDashboardMonitorsSyncBash(mailSettings) {
  const channelId = mailSettings.notifications.email_channel_id;
  const minLevel = mailSettings.alert_level;
  const monitorName = "hdc-wazuh-high-severity";
  return [
    `python3 - <<'PY'`,
    "import json",
    "import os",
    "import ssl",
    "import urllib.error",
    "import urllib.request",
    "",
    `channel_id = ${JSON.stringify(channelId)}`,
    `monitor_name = ${JSON.stringify(monitorName)}`,
    `min_level = ${minLevel}`,
    "api_pw = os.environ['WAZUH_API_PASSWORD']",
    "alert_base = 'https://127.0.0.1:9200/_plugins/_alerting/monitors'",
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
    "def find_monitor():",
    "  try:",
    "    data = request('POST', f'{alert_base}/_search', {'query': {'match': {'monitor.name': monitor_name}}, 'size': 10})",
    "  except urllib.error.HTTPError as e:",
    "    if e.code == 401:",
    "      print('dashboard monitors skipped: indexer returned 401')",
    "      raise SystemExit(0)",
    "    raise",
    "  hits = (((data.get('hits') or {}).get('hits')) or [])",
    "  return hits[0] if hits else None",
    "",
    "monitor_body = {",
    "  'type': 'monitor',",
    "  'name': monitor_name,",
    "  'enabled': True,",
    "  'schedule': {'period': {'interval': 5, 'unit': 'MINUTES'}},",
    "  'inputs': [{",
    "    'search': {",
    "      'indices': ['wazuh-alerts-*'],",
    "      'query': {",
    "        'size': 0,",
    "        'query': {",
    "          'bool': {",
    "            'filter': [",
    "              {'range': {'rule.level': {'gte': min_level}}},",
    "              {'range': {'@timestamp': {'gte': 'now-5m'}}},",
    "            ],",
    "          },",
    "        },",
    "      },",
    "    },",
    "  }],",
    "  'triggers': [{",
    "    'name': 'hdc-high-severity',",
    "    'severity': '1',",
    "    'condition': {'script': {'source': 'ctx.results[0].hits.total.value > 0', 'lang': 'painless'}},",
    "    'actions': [{",
    "      'name': 'hdc-email',",
    "      'destination_id': channel_id,",
    "      'message_template': {",
    "        'source': 'Wazuh alert level >= ' + str(min_level) + ': {{ctx.results.0.hits.total.value}} event(s) in the last 5 minutes.',",
    "      },",
    "    }],",
    "  }],",
    "}",
    "",
    "existing = find_monitor()",
    "if existing:",
    "  mid = existing.get('_id')",
    "  if mid:",
    "    request('PUT', f'{alert_base}/{mid}', monitor_body)",
    "    print(f'updated dashboard monitor {monitor_name}')",
    "  else:",
    "    print(f'dashboard monitor {monitor_name} already present')",
    "else:",
    "  request('POST', alert_base, monitor_body)",
    "  print(f'created dashboard monitor {monitor_name}')",
    "PY",
  ].join("\n");
}
