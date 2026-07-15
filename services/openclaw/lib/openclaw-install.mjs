import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  gatewayPort,
  openclawVersion,
  renderOpenclawEnvFile,
  renderOpenclawJson,
  shellQuoteSingle,
} from "./openclaw-render.mjs";
import { resolveLinuxUser } from "./openclaw-install-user.mjs";

export { resolveLinuxUser } from "./openclaw-install-user.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} install
 */
function resolveNodeMajor(install) {
  const raw =
    typeof install.node_version === "string" && install.node_version.trim()
      ? install.node_version.trim().replace(/^v/, "")
      : "24";
  if (!/^\d+$/.test(raw)) {
    throw new Error(`install.node_version invalid: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * @param {Record<string, unknown>} install
 */
function dockerEnabled(install) {
  return install.docker !== false;
}

/**
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} openclaw
 * @param {Record<string, string>} guestEnv
 * @param {{ upgrade?: boolean }} [opts]
 */
export function buildOpenclawInstallScript(install, openclaw, guestEnv, opts = {}) {
  const linuxUser = resolveLinuxUser(install);
  const nodeMajor = resolveNodeMajor(install);
  const withDocker = dockerEnabled(install);
  const version = openclawVersion(openclaw);
  const home = `/home/${linuxUser}`;
  const port = gatewayPort(openclaw);
  const configJson = renderOpenclawJson(openclaw);
  const envFile = renderOpenclawEnvFile(guestEnv);
  const envPath = "/etc/openclaw/openclaw.env";
  const configPath = `${home}/.openclaw/openclaw.json`;
  const upgrade = opts.upgrade === true;

  /** @type {string[]} */
  const dockerBlock = withDocker
    ? [
        "apt-get install -y -qq ca-certificates curl gnupg",
        "install -m 0755 -d /etc/apt/keyrings",
        "if [ ! -f /etc/apt/keyrings/docker.gpg ]; then",
        "  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg",
        "  chmod a+r /etc/apt/keyrings/docker.gpg",
        "fi",
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \\"${VERSION_CODENAME:-$VERSION_ID}\\") stable" > /etc/apt/sources.list.d/docker.list',
        "apt-get update -qq",
        "apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin",
        "systemctl enable -q docker",
        "systemctl start docker",
      ]
    : [];

  const npmInstallLine =
    version === "latest"
      ? "npm install -g openclaw@latest"
      : `npm install -g openclaw@${version.replace(/[^a-zA-Z0-9@._-]/g, "")}`;

  const upgradeBlock = upgrade
    ? [
        'if command -v openclaw >/dev/null 2>&1; then',
        "  openclaw update --yes || true",
        "fi",
        npmInstallLine,
      ]
    : [npmInstallLine];

  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "ROOT_PART=$(findmnt -n -o SOURCE / | sed 's/[0-9]*$//')",
    "ROOT_NUM=$(findmnt -n -o SOURCE / | grep -oE '[0-9]+$')",
    "if [ -n \"$ROOT_PART\" ] && [ -n \"$ROOT_NUM\" ]; then",
    "  growpart \"$ROOT_PART\" \"$ROOT_NUM\" 2>/dev/null || true",
    "  resize2fs \"$(findmnt -n -o SOURCE /)\" 2>/dev/null || true",
    "fi",
    "apt-get update -qq",
    "apt-get install -y -qq curl ca-certificates gnupg dbus-user-session",
    ...dockerBlock,
    `LINUX_USER=${JSON.stringify(linuxUser)}`,
    `OC_HOME=${JSON.stringify(home)}`,
    "if ! id \"$LINUX_USER\" >/dev/null 2>&1; then",
    "  useradd -m -s /bin/bash \"$LINUX_USER\"",
    "fi",
    "if ! getent group openclaw >/dev/null 2>&1; then",
    "  groupadd openclaw 2>/dev/null || true",
    "fi",
    "usermod -aG openclaw \"$LINUX_USER\" 2>/dev/null || true",
    withDocker ? "usermod -aG docker \"$LINUX_USER\" 2>/dev/null || true" : "",
    "loginctl enable-linger \"$LINUX_USER\"",
    "command -v node >/dev/null 2>&1 || {",
    `  curl -fsSL https://deb.nodesource.com/setup_${nodeMajor}.x | bash -`,
    "  apt-get install -y -qq nodejs",
    "}",
    `runuser -u "$LINUX_USER" -- env HOME="$OC_HOME" bash -lc ${shellQuoteSingle(
      [...upgradeBlock, "openclaw --version || true"].join(" && "),
    )}`,
    "install -d -m 0750 -o root -g openclaw /etc/openclaw",
    `cat > ${envPath} <<'HDC_OPENCLAW_ENV'\n${envFile}HDC_OPENCLAW_ENV`,
    "chmod 640 /etc/openclaw/openclaw.env",
    "chown root:openclaw /etc/openclaw/openclaw.env",
    `install -d -m 0755 -o "$LINUX_USER" -g "$LINUX_USER" "$OC_HOME/.openclaw"`,
    `cat > ${configPath} <<'HDC_OPENCLAW_JSON'\n${configJson}HDC_OPENCLAW_JSON`,
    `chown "$LINUX_USER:$LINUX_USER" ${configPath}`,
    `chmod 600 ${configPath}`,
    "install -d -m 0755 -o \"$LINUX_USER\" -g \"$LINUX_USER\" \"$OC_HOME/.config/systemd/user/openclaw-gateway.service.d\"",
    `cat > "$OC_HOME/.config/systemd/user/openclaw-gateway.service.d/hdc-env.conf" <<'HDC_SYSTEMD_DROPIN'
[Service]
EnvironmentFile=/etc/openclaw/openclaw.env
HDC_SYSTEMD_DROPIN`,
    `chown -R "$LINUX_USER:$LINUX_USER" "$OC_HOME/.config"`,
    `runuser -u "$LINUX_USER" -- env HOME="$OC_HOME" XDG_RUNTIME_DIR="/run/user/$(id -u "$LINUX_USER")" bash -lc ${shellQuoteSingle(
      [
        "export PATH=\"$(npm prefix -g)/bin:$PATH\"",
        "openclaw gateway install --force",
        "systemctl --user daemon-reload",
        "systemctl --user enable openclaw-gateway.service",
        "systemctl --user restart openclaw-gateway.service || systemctl --user start openclaw-gateway.service",
        "openclaw doctor --yes || openclaw doctor || true",
      ].join(" && "),
    )}`,
    `sleep 2`,
    `curl -fsS http://127.0.0.1:${port}/readyz || curl -fsS http://127.0.0.1:${port}/health || true`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {Record<string, unknown>} opts.install
 * @param {Record<string, unknown>} opts.openclaw
 * @param {Record<string, string>} opts.guestEnv
 * @param {{ upgrade?: boolean }} [opts.upgradeOpts]
 */
export async function installOpenclawInQemu(opts) {
  const { exec, log, install, openclaw, guestEnv, upgradeOpts } = opts;
  const inner = buildOpenclawInstallScript(install, openclaw, guestEnv, upgradeOpts);
  log.info(`${exec.label}: installing OpenClaw gateway …`);
  const r = exec.run(inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return {
    ok: true,
    linux_user: resolveLinuxUser(install),
    version: openclawVersion(openclaw),
    gateway_port: gatewayPort(openclaw),
    message: upgradeOpts?.upgrade ? "upgraded" : "installed",
  };
}

/**
 * Stop gateway before teardown.
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {Record<string, unknown>} install
 */
export function stopOpenclawGateway(exec, install) {
  const linuxUser = resolveLinuxUser(install);
  const script = [
    "set -euo pipefail",
    `LINUX_USER=${JSON.stringify(linuxUser)}`,
    `OC_HOME=/home/${linuxUser}`,
    `runuser -u "$LINUX_USER" -- env HOME="$OC_HOME" bash -lc 'systemctl --user stop openclaw-gateway.service 2>/dev/null || openclaw gateway stop 2>/dev/null || true'`,
  ].join("\n");
  exec.run(script, { capture: true });
}
