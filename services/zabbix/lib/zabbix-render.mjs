import { zabbixDatabase, zabbixServerPort, zabbixWebHttpPort } from "./deployments.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/zabbix";
}

/**
 * @param {Record<string, unknown>} install
 */
export function zabbixStackDir(install) {
  return `${composeDir(install)}/zabbix-docker`;
}

/**
 * @param {Record<string, unknown>} zabbix
 */
export function zabbixRelease(zabbix) {
  const raw = typeof zabbix.release === "string" && zabbix.release.trim() ? zabbix.release.trim() : "7.0";
  return raw.replace(/^v/i, "");
}

/**
 * @param {Record<string, unknown>} zabbix
 */
export function zabbixComposeFile(zabbix) {
  return zabbixDatabase(zabbix) === "mysql" ? "compose.yaml" : "compose_pgsql.yaml";
}

/**
 * @param {Record<string, unknown>} zabbix
 * @param {string} dbPassword
 * @param {string} [dbRootPassword]
 */
export function renderZabbixRootEnv(zabbix, dbPassword, dbRootPassword) {
  const release = zabbixRelease(zabbix);
  const webPort = zabbixWebHttpPort(zabbix);
  const serverPort = zabbixServerPort(zabbix);
  const lines = [
    `ZBX_VERSION=${release}`,
    `ZABBIX_WEB_NGINX_HTTP_PORT=${webPort}`,
    `ZABBIX_SERVER_PORT=${serverPort}`,
  ];
  if (zabbixDatabase(zabbix) === "mysql" && dbRootPassword) {
    lines.push(`MYSQL_ROOT_PASSWORD=${dbRootPassword}`);
  }
  void dbPassword;
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} zabbix
 * @param {string} stackShellExpr e.g. "$ZABBIX_ROOT/zabbix-docker" or quoted path
 * @param {string} dbPassword
 * @param {string} [dbRootPassword]
 */
export function buildEnvVarsWriteScript(zabbix, stackShellExpr, dbPassword, dbRootPassword) {
  const dbPass = dbPassword.replace(/'/g, `'\\''`);
  const lines = [`mkdir -p ${stackShellExpr}/env_vars`];
  if (zabbixDatabase(zabbix) === "mysql") {
    const rootPass = (dbRootPassword || dbPassword).replace(/'/g, `'\\''`);
    lines.push(
      `printf '%s' 'zabbix' > ${stackShellExpr}/env_vars/.MYSQL_USER`,
      `printf '%s' '${dbPass}' > ${stackShellExpr}/env_vars/.MYSQL_PASSWORD`,
      `printf '%s' '${rootPass}' > ${stackShellExpr}/env_vars/.MYSQL_ROOT_PASSWORD`,
    );
  } else {
    lines.push(
      `printf '%s' 'zabbix' > ${stackShellExpr}/env_vars/.POSTGRES_USER`,
      `printf '%s' '${dbPass}' > ${stackShellExpr}/env_vars/.POSTGRES_PASSWORD`,
    );
  }
  return lines.join("\n");
}

/**
 * @param {string} release
 * @param {string} composeFile
 * @param {Record<string, unknown>} zabbix
 * @param {string} dbPassword
 * @param {string} [dbRootPassword]
 */
export function buildOfficialStackInstallScript(release, composeFile, zabbix, dbPassword, dbRootPassword) {
  const branch = release.replace(/^v/i, "");
  const root = composeDir({}).replace(/'/g, `'\\''`);
  const stackExpr = '"$ZABBIX_ROOT/zabbix-docker"';
  const envVarsScript = buildEnvVarsWriteScript(zabbix, stackExpr, dbPassword, dbRootPassword);
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq ca-certificates curl gnupg git",
    "if ! command -v docker >/dev/null 2>&1; then",
    "  install -m 0755 -d /etc/apt/keyrings",
    "  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "  chmod a+r /etc/apt/keyrings/docker.asc",
    '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME:-$VERSION_ID}) stable" > /etc/apt/sources.list.d/docker.list',
    "  apt-get update -qq",
    "  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin",
    "fi",
    "systemctl enable --now docker",
    `export ZABBIX_ROOT='${root}'`,
    `export ZABBIX_BRANCH='${branch.replace(/'/g, `'\\''`)}'`,
    `export ZABBIX_COMPOSE_FILE='${composeFile.replace(/'/g, `'\\''`)}'`,
    'mkdir -p "$ZABBIX_ROOT"',
    'if test -d "$ZABBIX_ROOT/zabbix-docker/.git"; then',
    '  git -C "$ZABBIX_ROOT/zabbix-docker" fetch --depth 1 origin "$ZABBIX_BRANCH"',
    '  git -C "$ZABBIX_ROOT/zabbix-docker" checkout -f "$ZABBIX_BRANCH"',
    '  git -C "$ZABBIX_ROOT/zabbix-docker" reset --hard "origin/$ZABBIX_BRANCH" 2>/dev/null || git -C "$ZABBIX_ROOT/zabbix-docker" reset --hard "$ZABBIX_BRANCH"',
    "else",
    '  rm -rf "$ZABBIX_ROOT/zabbix-docker"',
    '  git clone --depth 1 --branch "$ZABBIX_BRANCH" https://github.com/zabbix/zabbix-docker.git "$ZABBIX_ROOT/zabbix-docker"',
    "fi",
    envVarsScript,
    `cat > "$ZABBIX_ROOT/zabbix-docker/.env" <<'HDCENV'`,
    renderZabbixRootEnv(zabbix, dbPassword, dbRootPassword).trimEnd(),
    "HDCENV",
    'cd "$ZABBIX_ROOT/zabbix-docker"',
    'docker compose -f "$ZABBIX_COMPOSE_FILE" pull',
    'docker compose -f "$ZABBIX_COMPOSE_FILE" up -d',
    'docker compose -f "$ZABBIX_COMPOSE_FILE" ps',
  ].join("\n");
}

/**
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} zabbix
 * @param {string} dbPassword
 * @param {string} [dbRootPassword]
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(install, zabbix, dbPassword, dbRootPassword, opts = {}) {
  const stack = zabbixStackDir(install).replace(/'/g, `'\\''`);
  const composeFile = zabbixComposeFile(zabbix);
  const envVarsScript = buildEnvVarsWriteScript(zabbix, shellQuote(stack), dbPassword, dbRootPassword);
  const lines = [
    "set -euo pipefail",
    `test -d '${stack}'`,
    envVarsScript,
    `cat > '${stack}/.env' <<'HDCENV'`,
    renderZabbixRootEnv(zabbix, dbPassword, dbRootPassword).trimEnd(),
    "HDCENV",
    `cd '${stack}'`,
  ];
  if (!opts.skipUpgrade) lines.push(`docker compose -f ${shellQuote(composeFile)} pull`);
  lines.push(
    `docker compose -f ${shellQuote(composeFile)} up -d`,
    `docker compose -f ${shellQuote(composeFile)} ps`,
  );
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} zabbix
 */
export function buildComposeDownScript(install, zabbix) {
  const stack = zabbixStackDir(install).replace(/'/g, `'\\''`);
  const composeFile = zabbixComposeFile(zabbix);
  return [
    "set -euo pipefail",
    `if test -d '${stack}'; then`,
    `  cd '${stack}' && docker compose -f ${shellQuote(composeFile)} down -v 2>/dev/null || true`,
    "fi",
  ].join("\n");
}

/**
 * @param {Record<string, unknown>} zabbix
 * @param {string | null} guestIp
 */
export function resolveWebUrl(zabbix, guestIp) {
  const configured =
    isObject(zabbix) && typeof zabbix.public_url === "string" && zabbix.public_url.trim()
      ? zabbix.public_url.trim()
      : null;
  if (configured) return configured;
  const port = zabbixWebHttpPort(isObject(zabbix) ? zabbix : {});
  if (guestIp) return port === 80 ? `http://${guestIp}/` : `http://${guestIp}:${port}/`;
  return null;
}
