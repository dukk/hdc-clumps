import {
  apiPort,
  dashboardEnabled,
  dashboardPort,
  dashboardUsername,
} from "./deployments.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} hermes
 */
export function normalizeImageTag(hermes) {
  const t = typeof hermes.image_tag === "string" ? hermes.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/hermes";
}

/**
 * @param {Record<string, unknown>} install
 */
export function dataSubdir(install) {
  const sub =
    typeof install.data_subdir === "string" && install.data_subdir.trim()
      ? install.data_subdir.trim()
      : "data";
  return sub.replace(/^\/+|\/+$/g, "");
}

/**
 * @param {Record<string, unknown>} install
 */
export function dataDir(install) {
  const base = composeDir(install);
  const sub = dataSubdir(install);
  return `${base}/${sub}`;
}

/**
 * @param {Record<string, unknown>} hermes
 */
export function resolveSearxngUrl(hermes) {
  const raw = hermes.searxng_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`hermes.searxng_url must be http(s)://… got ${JSON.stringify(s)}`);
  }
  return s;
}

/**
 * @typedef {object} HermesEnvSecrets
 * @property {string} openrouterApiKey
 * @property {string} dashboardPassword
 * @property {string} dashboardAuthSecret
 */

/**
 * @param {Record<string, unknown>} hermes
 * @param {HermesEnvSecrets} secrets
 * @param {Record<string, string>} [extraEnv]
 */
export function renderHermesEnv(hermes, secrets, extraEnv = {}) {
  const username = dashboardUsername(hermes);
  /** @type {string[]} */
  const lines = [
    "# hdc-generated — docker compose",
    `OPENROUTER_API_KEY=${secrets.openrouterApiKey}`,
  ];

  if (dashboardEnabled(hermes)) {
    lines.push(
      "HERMES_DASHBOARD=1",
      "HERMES_DASHBOARD_HOST=0.0.0.0",
      `HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${username}`,
      `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${secrets.dashboardPassword}`,
      `HERMES_DASHBOARD_BASIC_AUTH_SECRET=${secrets.dashboardAuthSecret}`,
    );
  }

  const searxngUrl = resolveSearxngUrl(hermes);
  if (searxngUrl) {
    lines.push(`SEARXNG_URL=${searxngUrl}`);
  }

  for (const [key, value] of Object.entries(extraEnv)) {
    if (!key.trim() || !value) continue;
    lines.push(`${key}=${value}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} hermes
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(hermes, install) {
  const tag = normalizeImageTag(hermes);
  const api = apiPort(hermes);
  const dash = dashboardPort(hermes);
  const dir = composeDir(install);
  const data = dataDir(install);

  /** @type {string[]} */
  const portLines = [`      - "${api}:8642"`];
  if (dashboardEnabled(hermes)) {
    portLines.push(`      - "${dash}:9119"`);
  }

  return `# hdc-generated — see https://hermes-agent.nousresearch.com/docs/user-guide/docker
name: hermes

services:
  gateway:
    container_name: hermes
    image: nousresearch/hermes-agent:\${HERMES_IMAGE_TAG:-${tag}}
    restart: unless-stopped
    command: ["gateway", "run"]
    ports:
${portLines.join("\n")}
    env_file: ./.env
    volumes:
      - ${JSON.stringify(`${data}:/opt/data`)}
`;
}

/**
 * @param {Record<string, unknown>} install
 */
export function renderComposeEnvFile(hermes) {
  const tag = normalizeImageTag(hermes);
  return `HERMES_IMAGE_TAG=${tag}\n`;
}

/**
 * @param {Record<string, unknown>} hermes
 * @param {string | null} ctIp
 */
export function resolveDashboardUrl(hermes, ctIp) {
  if (!dashboardEnabled(hermes) || !ctIp) return null;
  const port = dashboardPort(hermes);
  return `http://${ctIp}:${port}`;
}

/**
 * @param {Record<string, unknown>} hermes
 * @param {string | null} ctIp
 */
export function resolveApiUrl(hermes, ctIp) {
  if (!ctIp) return null;
  const port = apiPort(hermes);
  return `http://${ctIp}:${port}`;
}

/**
 * @param {Record<string, unknown>} install
 */
export function buildDataDirScript(install) {
  const data = dataDir(install).replace(/'/g, `'\\''`);
  return [`mkdir -p '${data}'`, `chmod 700 '${data}'`].join("\n");
}
