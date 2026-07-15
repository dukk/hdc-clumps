import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { normalizeReleaseTag } from "./postiz-release.mjs";
import { appDir, renderPostizEnv, resolveAccessUrl, resolveBaseUrl } from "./postiz-render.mjs";

export { resolvePveSshForHost };

const POSTIZ_SERVICES = [
  "postiz-orchestrator",
  "postiz-frontend",
  "postiz-backend",
  "postiz-temporal",
];

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function readCtPrimaryIp(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  if (r.status !== 0) return null;
  const ip = r.stdout.trim().split(/\s+/)[0];
  return ip || null;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function readInstalledVersion(user, pveHost, vmid) {
  const dir = "/opt/postiz";
  const r = pctExec(user, pveHost, vmid, `test -f ${dir}/.hdc-installed-version && cat ${dir}/.hdc-installed-version`, {
    capture: true,
  });
  if (r.status !== 0) return null;
  const v = r.stdout.trim();
  return v || null;
}

/**
 * @param {string} appDirPath
 * @param {string} envContent
 * @param {string} tag
 * @param {string} tarballUrl
 */
export function buildInstallScript(appDirPath, envContent, tag, tarballUrl) {
  const dir = appDirPath.replace(/'/g, `'\\''`);
  const qTag = `'${tag.replace(/'/g, `'\\''`)}'`;
  const qTarball = `'${tarballUrl.replace(/'/g, `'\\''`)}'`;

  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "",
    "apt-get update -qq",
    "apt-get install -y -qq build-essential python3 redis-server nginx curl ca-certificates gnupg lsb-release",
    "",
    "curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --batch --yes --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg",
    'echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list',
    "apt-get update -qq",
    "apt-get install -y -qq postgresql-17",
    "",
    "systemctl enable --now redis-server",
    "",
    "export HDC_POSTIZ_DB_PASS='HDC_POSTIZ_DB_PLACEHOLDER'",
    "sudo -u postgres psql -tc \"SELECT 1 FROM pg_roles WHERE rolname = 'postiz'\" | grep -q 1 || sudo -u postgres psql -c \"CREATE USER postiz WITH PASSWORD '$HDC_POSTIZ_DB_PASS'\"",
    "sudo -u postgres psql -c \"ALTER USER postiz WITH PASSWORD '$HDC_POSTIZ_DB_PASS'\"",
    "sudo -u postgres psql -tc \"SELECT 1 FROM pg_database WHERE datname = 'postiz'\" | grep -q 1 || sudo -u postgres psql -c \"CREATE DATABASE postiz OWNER postiz\"",
    "",
    "command -v node >/dev/null 2>&1 || curl -fsSL https://deb.nodesource.com/setup_24.x | bash -",
    "apt-get install -y -qq nodejs",
    "",
    "mkdir -p /opt/temporal",
    "TEMPORAL_ASSET=$(curl -fsSL https://api.github.com/repos/temporalio/cli/releases/latest | grep -o 'https://[^\"]*linux_amd64.tar.gz' | head -1)",
    'test -n "$TEMPORAL_ASSET"',
    'curl -fsSL "$TEMPORAL_ASSET" -o /tmp/temporal_cli.tar.gz',
    "tar -xzf /tmp/temporal_cli.tar.gz -C /opt/temporal",
    'TEMPORAL_BIN=$(find /opt/temporal -maxdepth 3 -type f -name temporal -perm -111 2>/dev/null | head -1)',
    'test -n "$TEMPORAL_BIN"',
    'if [ "$TEMPORAL_BIN" != /opt/temporal/temporal ]; then ln -sf "$TEMPORAL_BIN" /opt/temporal/temporal; fi',
    "chmod +x /opt/temporal/temporal",
    "rm -f /tmp/temporal_cli.tar.gz",
    "",
    `rm -rf '${dir}'`,
    `mkdir -p '${dir}'`,
    `curl -fsSL ${qTarball} -o /tmp/postiz-src.tar.gz`,
    "tar -xzf /tmp/postiz-src.tar.gz -C /tmp",
    "SRC_DIR=$(find /tmp -maxdepth 1 -type d \\( -name 'postiz-app-*' -o -name 'postiz-*' \\) | head -1)",
    'test -n "$SRC_DIR" && test -d "$SRC_DIR"',
    `cp -a "$SRC_DIR"/. '${dir}/'`,
    "rm -rf /tmp/postiz-src.tar.gz /tmp/postiz-app-* /tmp/postiz-*",
    "",
    `cd '${dir}'`,
    "PNPM_VERSION=$(sed -n 's/.*\"packageManager\":\\s*\"pnpm@\\([^\"]*\\)\".*/\\1/p' package.json)",
    'test -n "$PNPM_VERSION"',
    "npm install -g \"pnpm@${PNPM_VERSION}\"",
    "",
    `mkdir -p '${dir}/uploads'`,
    `cat > '${dir}/.env' <<'HDCPOSTIZENV'`,
    envContent.trimEnd(),
    "HDCPOSTIZENV",
    "",
    `cd '${dir}'`,
    "set -a && source .env && set +a",
    "export NODE_OPTIONS=\"--max-old-space-size=4096\"",
    "pnpm install",
    "pnpm run build",
    "unset NODE_OPTIONS",
    "",
    `cd '${dir}'`,
    "set -a && source .env && set +a",
    "pnpm run prisma-db-push",
    "",
    "PNPM_BIN=$(command -v pnpm)",
    _systemdUnitsBlock(),
    "",
    _nginxSiteBlock(),
    "ln -sf /etc/nginx/sites-available/postiz /etc/nginx/sites-enabled/postiz",
    "rm -f /etc/nginx/sites-enabled/default",
    "nginx -t",
    "systemctl enable --now nginx redis-server postiz-temporal postiz-backend postiz-frontend postiz-orchestrator",
    "",
    _postizRebuildScriptBlock(dir),
    `echo ${qTag} > '${dir}/.hdc-installed-version'`,
  ].join("\n");
}

function _systemdUnitsBlock() {
  return [
    "cat <<'EOF' >/etc/systemd/system/postiz-temporal.service",
    "[Unit]",
    "Description=Temporal Dev Server (Postiz)",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    "User=root",
    "ExecStart=/opt/temporal/temporal server start-dev --db-filename /opt/temporal/temporal.db --log-format json --log-level warn",
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "EOF",
    "",
    'test -n "$PNPM_BIN" && test -x "$PNPM_BIN"',
    _systemdPnpmUnitBlock("backend", {
      after: "network.target postgresql.service redis-server.service postiz-temporal.service",
      requires: "postgresql.service redis-server.service",
      execStart: "run start:prod:backend",
      nodeHeap: "512",
    }),
    "",
    _systemdPnpmUnitBlock("frontend", {
      after: "network.target postiz-backend.service",
      execStart: "run start:prod:frontend",
      nodeHeap: "512",
      extraService: ["Environment=PORT=4200"],
    }),
    "",
    _systemdPnpmUnitBlock("orchestrator", {
      after: "network.target postiz-temporal.service postiz-backend.service",
      requires: "postiz-temporal.service",
      execStart: "run start:prod:orchestrator",
      nodeHeap: "384",
    }),
    "systemctl daemon-reload",
  ].join("\n");
}

/**
 * Systemd unit with ExecStart expanded from $PNPM_BIN (unquoted heredoc).
 * @param {string} name
 * @param {{ after: string; requires?: string; execStart: string; nodeHeap: string; extraService?: string[] }} spec
 */
function _systemdPnpmUnitBlock(name, spec) {
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  const lines = [
    "[Unit]",
    `Description=Postiz ${title}`,
    `After=${spec.after}`,
  ];
  if (spec.requires) {
    lines.push(`Requires=${spec.requires}`);
  }
  lines.push(
    "",
    "[Service]",
    "Type=simple",
    "User=root",
    "WorkingDirectory=/opt/postiz",
    "EnvironmentFile=/opt/postiz/.env",
  );
  if (spec.extraService) {
    lines.push(...spec.extraService);
  }
  lines.push(
    `ExecStart=$PNPM_BIN ${spec.execStart}`,
    `Environment=NODE_OPTIONS=--max-old-space-size=${spec.nodeHeap}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  );
  return [
    `cat <<EOF >/etc/systemd/system/postiz-${name}.service`,
    ...lines,
    "EOF",
  ].join("\n");
}

function _nginxSiteBlock() {
  return [
    "cat <<'EOF' >/etc/nginx/sites-available/postiz",
    "server {",
    "  listen 80 default_server;",
    "  server_name _;",
    "  client_max_body_size 100M;",
    "  gzip on;",
    "  gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;",
    "  location /api/ {",
    "    proxy_pass http://127.0.0.1:3000/;",
    "    proxy_http_version 1.1;",
    "    proxy_set_header Upgrade $http_upgrade;",
    "    proxy_set_header Connection \"upgrade\";",
    "    proxy_set_header Host $host;",
    "    proxy_set_header X-Real-IP $remote_addr;",
    "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "    proxy_set_header X-Forwarded-Proto $scheme;",
    "  }",
    "  location /uploads/ {",
    "    alias /opt/postiz/uploads/;",
    "  }",
    "  location / {",
    "    proxy_pass http://127.0.0.1:4200/;",
    "    proxy_http_version 1.1;",
    "    proxy_set_header Upgrade $http_upgrade;",
    "    proxy_set_header Connection \"upgrade\";",
    "    proxy_set_header Host $host;",
    "    proxy_set_header X-Real-IP $remote_addr;",
    "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "    proxy_set_header X-Forwarded-Proto $scheme;",
    "  }",
    "}",
    "EOF",
  ].join("\n");
}

/**
 * @param {string} appDirPath
 */
function _postizRebuildScriptBlock(appDirPath) {
  const dir = appDirPath.replace(/'/g, `'\\''`);
  return [
    "cat <<'EOF' >/usr/local/bin/postiz-rebuild",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo \"=== Postiz Rebuild ===\"",
    "systemctl stop postiz-orchestrator postiz-frontend postiz-backend",
    `cd '${dir}'`,
    "set -a && source .env && set +a",
    "export NODE_OPTIONS=\"--max-old-space-size=4096\"",
    "pnpm run build",
    "unset NODE_OPTIONS",
    "pnpm run prisma-db-push",
    "systemctl start postiz-backend postiz-frontend postiz-orchestrator",
    "echo \"=== Rebuild complete ===\"",
    "EOF",
    "chmod +x /usr/local/bin/postiz-rebuild",
  ].join("\n");
}

/**
 * @param {string} appDirPath
 * @param {string} envContent
 */
export function buildRestartScript(appDirPath, envContent) {
  const dir = appDirPath.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `test -d '${dir}'`,
    `cat > '${dir}/.env' <<'HDCPOSTIZENV'`,
    envContent.trimEnd(),
    "HDCPOSTIZENV",
    "systemctl restart postiz-temporal postiz-backend postiz-frontend postiz-orchestrator",
    "systemctl reload nginx || systemctl restart nginx",
  ].join("\n");
}

/**
 * @param {string} appDirPath
 */
export function buildRebuildScript(appDirPath) {
  const dir = appDirPath.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `test -x /usr/local/bin/postiz-rebuild`,
    "/usr/local/bin/postiz-rebuild",
    `test -d '${dir}'`,
  ].join("\n");
}

/**
 * @param {string} appDirPath
 * @param {string} envContent
 */
export function buildEnvPushScript(appDirPath, envContent) {
  const dir = appDirPath.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `test -d '${dir}'`,
    `cat > '${dir}/.env' <<'HDCPOSTIZENV'`,
    envContent.trimEnd(),
    "HDCPOSTIZENV",
  ].join("\n");
}

/**
 * @param {string} script
 * @param {string} dbPassword
 */
function injectDbPassword(script, dbPassword) {
  const escaped = dbPassword.replace(/'/g, `'\\''`);
  return script.replace(/HDC_POSTIZ_DB_PLACEHOLDER/g, escaped);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function stopPostizServicesInCt(user, pveHost, vmid) {
  const units = POSTIZ_SERVICES.join(" ");
  pctExec(user, pveHost, vmid, `systemctl stop ${units} 2>/dev/null || true`);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} postiz
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {string} jwtSecret
 * @param {{ tag: string; tarballUrl: string }} release
 */
export async function installPostizInCt(user, pveHost, vmid, postiz, install, dbPassword, jwtSecret, release) {
  errout.write(`[hdc] postiz install: native stack in CT ${vmid} (build may take several minutes) …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "postiz install");
  if (!ready) {
    return { ok: false, method: "native", message: `CT ${vmid} not reachable via pct exec` };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const baseUrl = resolveBaseUrl(postiz, ip);
  if (!baseUrl) {
    return { ok: false, method: "native", message: "could not resolve public URL or CT IP" };
  }

  const dir = appDir(install);
  const envContent = renderPostizEnv(postiz, dbPassword, jwtSecret, baseUrl);
  const tag = normalizeReleaseTag(release.tag);
  let inner = buildInstallScript(dir, envContent, tag, release.tarballUrl);
  inner = injectDbPassword(inner, dbPassword);

  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    const tail = [r.stdout, r.stderr]
      .join("\n")
      .trim()
      .split("\n")
      .slice(-30)
      .join("\n");
    if (tail) {
      errout.write(`[hdc] postiz install: last output from CT ${vmid}:\n${tail}\n`);
    }
    return {
      ok: false,
      method: "native",
      message: `install failed (exit ${r.status})`,
    };
  }

  const accessUrl = resolveAccessUrl(postiz, ip);
  errout.write(`[hdc] postiz install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "native",
    message: "installed",
    version: tag,
    access_url: accessUrl,
    ct_ip: ip,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} postiz
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 * @param {string} jwtSecret
 * @param {{ skipUpgrade?: boolean; rebuild?: boolean }} [opts]
 */
export async function maintainPostizInCt(
  user,
  pveHost,
  vmid,
  postiz,
  install,
  dbPassword,
  jwtSecret,
  opts = {},
) {
  const ready = await waitForCt(user, pveHost, vmid, 2000, "postiz maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const dir = appDir(install);
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const baseUrl = resolveBaseUrl(postiz, ip);
  if (!baseUrl) {
    return { ok: false, message: "could not resolve public URL or CT IP" };
  }
  const envContent = renderPostizEnv(postiz, dbPassword, jwtSecret, baseUrl);

  if (opts.rebuild) {
    errout.write(`[hdc] postiz maintain: rebuild (NEXT_PUBLIC_* / URL) on CT ${vmid} …\n`);
    pctExec(user, pveHost, vmid, buildEnvPushScript(dir, envContent));
    const inner = buildRebuildScript(dir);
    const r = pctExec(user, pveHost, vmid, inner);
    if (r.status !== 0) {
      return { ok: false, message: `rebuild failed (exit ${r.status})` };
    }
    return {
      ok: true,
      rebuilt: true,
      access_url: resolveAccessUrl(postiz, ip),
      message: "rebuilt",
    };
  }

  if (opts.skipUpgrade) {
    errout.write(`[hdc] postiz maintain: restart services on CT ${vmid} …\n`);
    const inner = buildRestartScript(dir, envContent);
    const r = pctExec(user, pveHost, vmid, inner);
    if (r.status !== 0) {
      return { ok: false, message: `restart failed (exit ${r.status})` };
    }
    return {
      ok: true,
      upgraded: false,
      access_url: resolveAccessUrl(postiz, ip),
      message: "restarted",
    };
  }

  const { maintainPostizUpgradeInCt } = await import("./postiz-maintain.mjs");
  return maintainPostizUpgradeInCt(user, pveHost, vmid, postiz, install, dbPassword, jwtSecret, envContent, opts);
}
