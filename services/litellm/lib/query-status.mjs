import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { composeDir, hostPort, parsePublicUrl } from "./litellm-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Guest probe: DB password drift (booleans only) + optional /v1/models.
 * Never prints secret values.
 * @param {string} composeDirPath
 * @param {number} port
 */
function buildDbAndModelsProbeScript(composeDirPath, port) {
  const dirJson = JSON.stringify(composeDirPath);
  const portLit = String(Number(port) || 4000);
  return [
    "set -euo pipefail",
    "python3 - <<'PY'",
    "import json, subprocess, sys",
    "from pathlib import Path",
    "from urllib.parse import unquote, urlparse",
    "import urllib.request",
    "",
    `dir_path = ${dirJson}`,
    `port = ${portLit}`,
    "",
    "def env_from_container(name):",
    "    r = subprocess.run(",
    "        ['docker', 'inspect', name, '--format', '{{range .Config.Env}}{{println .}}{{end}}'],",
    "        capture_output=True,",
    "        text=True,",
    "    )",
    "    d = {}",
    "    if r.returncode != 0:",
    "        return d",
    "    for line in (r.stdout or '').splitlines():",
    "        if '=' in line:",
    "            k, v = line.split('=', 1)",
    "            d[k] = v",
    "    return d",
    "",
    "def psql_ok(password):",
    "    if not password:",
    "        return False",
    "    r = subprocess.run(",
    "        [",
    "            'docker', 'exec', '-e', f'PGPASSWORD={password}',",
    "            'litellm-db', 'psql', '-U', 'llmproxy', '-d', 'litellm', '-c', 'select 1',",
    "        ],",
    "        capture_output=True,",
    "        text=True,",
    "    )",
    "    return r.returncode == 0",
    "",
    "out = {",
    "    'db_auth': {",
    "        'file_has_db_password': False,",
    "        'file_eq_container': None,",
    "        'psql_ok_with_file_password': None,",
    "        'psql_ok_with_container_password': None,",
    "        'url_password_eq_file': None,",
    "    },",
    "    'models_http_ok': None,",
    "    'models_count': None,",
    "    'models_error': None,",
    "}",
    "",
    "file_env = {}",
    "env_path = Path(dir_path) / '.env'",
    "if env_path.is_file():",
    "    for line in env_path.read_text().splitlines():",
    "        if '=' in line and not line.startswith('#'):",
    "            k, v = line.split('=', 1)",
    "            file_env[k] = v",
    "",
    "db = env_from_container('litellm-db')",
    "app = env_from_container('litellm')",
    "file_pw = file_env.get('LITELLM_DB_PASSWORD') or file_env.get('POSTGRES_PASSWORD') or ''",
    "db_pw = db.get('POSTGRES_PASSWORD') or ''",
    "out['db_auth']['file_has_db_password'] = bool(file_pw)",
    "if file_pw and db_pw:",
    "    out['db_auth']['file_eq_container'] = file_pw == db_pw",
    "elif file_pw or db_pw:",
    "    out['db_auth']['file_eq_container'] = False",
    "",
    "out['db_auth']['psql_ok_with_file_password'] = psql_ok(file_pw) if file_pw else False",
    "out['db_auth']['psql_ok_with_container_password'] = psql_ok(db_pw) if db_pw else False",
    "",
    "url = app.get('DATABASE_URL') or file_env.get('DATABASE_URL') or ''",
    "if url and file_pw:",
    "    try:",
    "        url_pw = unquote(urlparse(url).password or '')",
    "        out['db_auth']['url_password_eq_file'] = url_pw == file_pw",
    "    except Exception:",
    "        out['db_auth']['url_password_eq_file'] = False",
    "",
    "master = file_env.get('LITELLM_MASTER_KEY') or ''",
    "if master:",
    "    req = urllib.request.Request(",
    "        f'http://127.0.0.1:{port}/v1/models',",
    "        headers={'Authorization': f'Bearer {master}'},",
    "    )",
    "    try:",
    "        with urllib.request.urlopen(req, timeout=15) as resp:",
    "            body = json.loads(resp.read().decode())",
    "            data = body.get('data') if isinstance(body, dict) else None",
    "            out['models_http_ok'] = resp.status == 200",
    "            out['models_count'] = len(data) if isinstance(data, list) else None",
    "    except Exception as e:",
    "        out['models_http_ok'] = False",
    "        out['models_error'] = str(e)[:200]",
    "else:",
    "    out['models_error'] = 'LITELLM_MASTER_KEY missing from guest .env'",
    "",
    "print(json.dumps(out))",
    "PY",
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} litellm
 * @param {Record<string, unknown>} install
 */
export async function queryLitellmInCt(user, pveHost, vmid, litellm, install) {
  const cfg = isObject(litellm) ? litellm : {};
  const port = hostPort(cfg);
  const dir = composeDir(isObject(install) ? install : {});
  let publicOrigin = null;
  try {
    const parsed = parsePublicUrl(cfg);
    publicOrigin = parsed ? parsed.origin.replace(/\/+$/, "") : null;
  } catch {
    publicOrigin = null;
  }

  const docker = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active docker 2>/dev/null || echo inactive",
    { capture: true },
  );
  const composePs = pctExec(
    user,
    pveHost,
    vmid,
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  let healthOk = null;
  let healthError = null;
  if (docker.stdout.trim() === "active") {
    const healthUrl = publicOrigin
      ? `${publicOrigin}/health/liveliness`
      : `http://127.0.0.1:${port}/health/liveliness`;
    const healthCmd = `curl -sf --max-time 5 ${JSON.stringify(healthUrl)} -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      healthOk = true;
    } else {
      healthOk = false;
      healthError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  /** @type {Record<string, unknown> | null} */
  let dbAuth = null;
  /** @type {boolean | null} */
  let modelsHttpOk = null;
  /** @type {number | null} */
  let modelsCount = null;
  /** @type {string | null} */
  let modelsError = null;
  if (docker.stdout.trim() === "active") {
    const probe = pctExec(user, pveHost, vmid, buildDbAndModelsProbeScript(dir, port), {
      capture: true,
    });
    if (probe.status === 0) {
      try {
        const parsed = JSON.parse((probe.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "{}");
        if (isObject(parsed.db_auth)) dbAuth = parsed.db_auth;
        if (typeof parsed.models_http_ok === "boolean") modelsHttpOk = parsed.models_http_ok;
        if (typeof parsed.models_count === "number") modelsCount = parsed.models_count;
        if (typeof parsed.models_error === "string") modelsError = parsed.models_error;
      } catch {
        modelsError = "failed to parse db/models probe JSON";
      }
    } else {
      modelsError = (probe.stderr || probe.stdout || `probe exit ${probe.status}`).slice(0, 200);
    }
  }

  const apiUrl = publicOrigin ? `${publicOrigin}/v1` : ctIp ? `http://${ctIp}:${port}/v1` : null;
  const uiUrl = publicOrigin ? `${publicOrigin}/ui` : ctIp ? `http://${ctIp}:${port}/ui` : null;

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    health_ok: healthOk,
    health_error: healthError,
    db_auth: dbAuth,
    models_http_ok: modelsHttpOk,
    models_count: modelsCount,
    models_error: modelsError,
    host_port: port,
    upstream_url: ctIp ? `http://${ctIp}:${port}` : null,
    api_url: apiUrl,
    ui_url: uiUrl,
  };
}
