import { hostPort, instanceName, limiterEnabled } from "./deployments.mjs";

/** Upstream default settings shipped with SearXNG releases. */
export const UPSTREAM_SETTINGS_YAML_URL =
  "https://raw.githubusercontent.com/searxng/searxng/master/searx/settings.yml";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} searxng
 */
export function normalizeImageTag(searxng) {
  const t = typeof searxng.image_tag === "string" ? searxng.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/searxng";
}

/**
 * @param {string} s
 */
function yamlQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Patch upstream settings.yml for hdc Docker Compose (valkey service name `valkey`).
 * @param {string} baseYaml
 * @param {Record<string, unknown>} searxng
 */
export function patchSettingsYaml(baseYaml, searxng) {
  const port = hostPort(searxng);
  const name = instanceName(searxng);
  const limiter = limiterEnabled(searxng);
  const publicUrl =
    typeof searxng.public_url === "string" && searxng.public_url.trim()
      ? searxng.public_url.trim()
      : null;
  const baseUrlValue = publicUrl ? yamlQuote(publicUrl) : "false";

  let yaml = baseYaml;

  yaml = yaml.replace(/^(\s*instance_name:\s*).+$/m, `$1${yamlQuote(name)}`);
  yaml = yaml.replace(
    /(server:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+port:\s*)\d+/,
    `$1${port}`,
  );
  yaml = yaml.replace(
    /(server:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+bind_address:\s*).+/,
    `$1"0.0.0.0"`,
  );
  yaml = yaml.replace(
    /(server:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+base_url:\s*).+/,
    `$1${baseUrlValue}`,
  );
  yaml = yaml.replace(
    /(server:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+limiter:\s*).+/,
    `$1${limiter ? "true" : "false"}`,
  );
  yaml = yaml.replace(
    /(valkey:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+url:\s*).+/,
    "$1valkey://valkey:6379/0",
  );

  // Upstream master settings can include engines the Docker tag rejects at startup.
  yaml = yaml.replace(
    /(^[ \t]*-[ \t]+name:[ \t]*abcnyheter[ \t]*\n)((?:[ \t]+[^\n]*\n)*)/m,
    (match, head, body) => {
      if (/^[ \t]+disabled:[ \t]*true[ \t]*$/m.test(body)) return match;
      return `${head}    disabled: true\n${body}`;
    },
  );

  return yaml.endsWith("\n") ? yaml : `${yaml}\n`;
}

/**
 * @param {string} [url]
 */
export async function fetchUpstreamSettingsYaml(url = UPSTREAM_SETTINGS_YAML_URL) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch upstream settings.yml failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text.includes("engines:")) {
    throw new Error("upstream settings.yml looks incomplete (missing engines:)");
  }
  return text;
}

/**
 * Prefer upstream settings.yml (patched) so SearXNG schema validation passes.
 * @param {Record<string, unknown>} searxng
 */
export async function resolveSettingsYaml(searxng) {
  try {
    const base = await fetchUpstreamSettingsYaml();
    return patchSettingsYaml(base, searxng);
  } catch (e) {
    return renderSettingsYaml(searxng);
  }
}

/**
 * Fetch upstream settings.yml inside the guest and patch hdc values (avoids huge pct exec payloads).
 * @param {string} composeDirPath
 * @param {Record<string, unknown>} searxng
 */
export function buildFetchSettingsScript(composeDirPath, searxng) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const port = hostPort(searxng);
  const name = instanceName(searxng).replace(/\\/g, "\\\\").replace(/'/g, `'\\''`);
  const limiter = limiterEnabled(searxng) ? "true" : "false";
  const publicUrl =
    typeof searxng.public_url === "string" && searxng.public_url.trim()
      ? searxng.public_url.trim().replace(/\\/g, "\\\\").replace(/'/g, `'\\''`)
      : "";

  return [
    `mkdir -p '${dir}/core-config'`,
    `curl -fsSL '${UPSTREAM_SETTINGS_YAML_URL}' -o '${dir}/core-config/settings.yml'`,
    `HDC_SEARXNG_PORT='${port}' HDC_SEARXNG_NAME='${name}' HDC_SEARXNG_LIMITER='${limiter}' python3 - <<'HDCPY'`,
    "import os, pathlib, re",
    `p = pathlib.Path('${dir}/core-config/settings.yml')`,
    "yaml = p.read_text()",
    "name = os.environ['HDC_SEARXNG_NAME']",
    "port = os.environ['HDC_SEARXNG_PORT']",
    "limiter = os.environ['HDC_SEARXNG_LIMITER']",
    `public_url = ${publicUrl ? JSON.stringify(publicUrl) : JSON.stringify("false")}`,
    "base_url_val = public_url if public_url == 'false' else f'\"{public_url}\"'",
    "yaml = re.sub(r'^(\\s*instance_name:\\s*).+$', lambda m: m.group(1) + '\"' + name + '\"', yaml, count=1, flags=re.M)",
    "yaml = re.sub(r'(server:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+port:\\s*)\\d+', lambda m: m.group(1) + port, yaml, count=1)",
    "yaml = re.sub(r'(server:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+bind_address:\\s*).+', lambda m: m.group(1) + '\"0.0.0.0\"', yaml, count=1)",
    "yaml = re.sub(r'(server:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+base_url:\\s*).+', lambda m: m.group(1) + base_url_val, yaml, count=1)",
    "yaml = re.sub(r'(server:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+limiter:\\s*).+', lambda m: m.group(1) + limiter, yaml, count=1)",
    "yaml = re.sub(r'(valkey:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+url:\\s*).+', lambda m: m.group(1) + 'valkey://valkey:6379/0', yaml, count=1)",
    "m = re.search(r'(^[ \\t]*-[ \\t]+name:[ \\t]*abcnyheter[ \\t]*\\n)((?:[ \\t]+[^\\n]*\\n)*)', yaml, flags=re.M)",
    "if m and not re.search(r'^[ \\t]+disabled:[ \\t]*true[ \\t]*$', m.group(2), flags=re.M):",
    "    yaml = yaml[:m.start()] + m.group(1) + '    disabled: true\\n' + m.group(2) + yaml[m.end():]",
    "if 'engines:' not in yaml:",
    "    raise SystemExit('upstream settings.yml missing engines:')",
    "p.write_text(yaml if yaml.endswith('\\n') else yaml + '\\n')",
    "HDCPY",
  ].join("\n");
}

/**
 * Legacy minimal settings (fallback when upstream fetch fails).
 * @param {Record<string, unknown>} searxng
 */
export function renderSettingsYaml(searxng) {
  const port = hostPort(searxng);
  const name = instanceName(searxng);
  const limiter = limiterEnabled(searxng);
  const publicUrl =
    typeof searxng.public_url === "string" && searxng.public_url.trim()
      ? searxng.public_url.trim()
      : null;
  const baseUrlLine = publicUrl ? `  base_url: ${yamlQuote(publicUrl)}` : "  base_url: false";

  return `general:
  instance_name: ${yamlQuote(name)}
server:
  port: ${port}
  bind_address: "0.0.0.0"
${baseUrlLine}
  limiter: ${limiter ? "true" : "false"}
  public_instance: false
  secret_key: "placeholder"
valkey:
  url: valkey://valkey:6379/0
`;
}

/**
 * @param {Record<string, unknown>} searxng
 * @param {string} secret
 */
export function renderSearxngEnv(searxng, secret) {
  const tag = normalizeImageTag(searxng);
  const port = hostPort(searxng);
  const lines = [
    "# hdc-generated — docker compose",
    `SEARXNG_VERSION=${tag}`,
    `SEARXNG_PORT=${port}`,
    `SEARXNG_SECRET=${secret}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `# hdc-generated — see https://docs.searxng.org/admin/installation-docker.html
name: searxng

services:
  core:
    container_name: searxng-core
    image: docker.io/searxng/searxng:\${SEARXNG_VERSION:-latest}
    restart: always
    ports:
      - \${SEARXNG_HOST:+\${SEARXNG_HOST}:}\${SEARXNG_PORT:-8080}:\${SEARXNG_PORT:-8080}
    env_file: ./.env
    volumes:
      - ./core-config/:/etc/searxng/:Z
      - core-data:/var/cache/searxng/

  valkey:
    container_name: searxng-valkey
    image: docker.io/valkey/valkey:9-alpine
    command: valkey-server --save 30 1 --loglevel warning
    restart: always
    volumes:
      - valkey-data:/data/

volumes:
  core-data:
  valkey-data:
`;
}

/**
 * @param {Record<string, unknown>} searxng
 * @param {string | null} ctIp
 */
export function resolvePublicUrl(searxng, ctIp) {
  const configured =
    typeof searxng.public_url === "string" && searxng.public_url.trim() ? searxng.public_url.trim() : null;
  if (configured) return configured;
  const port = hostPort(searxng);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} searxng
 */
export function resolveUiUrl(ctIp, searxng) {
  return resolvePublicUrl(isObject(searxng) ? searxng : {}, ctIp);
}
