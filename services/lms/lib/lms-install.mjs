import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";

const INSTALL_SH_URL = "https://lmstudio.ai/install.sh";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} install
 */
export function resolveLinuxUser(install) {
  const raw =
    typeof install.linux_user === "string" && install.linux_user.trim()
      ? install.linux_user.trim()
      : "lms";
  if (!/^[a-z][a-z0-9_-]*$/.test(raw)) {
    throw new Error(`install.linux_user invalid: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * @param {boolean} gpu
 * @param {"nvidia" | "intel" | undefined} gpuBackend
 */
function nvidiaDriverInstallBlock(gpu, gpuBackend) {
  if (!gpu || gpuBackend !== "nvidia") return [];
  return [
    "apt-get install -y -qq ubuntu-drivers-common",
    "DEBIAN_FRONTEND=noninteractive ubuntu-drivers install nvidia || ubuntu-drivers autoinstall",
  ];
}

/**
 * @param {Record<string, unknown>} install
 */
function resolveGpuBackend(install) {
  const raw =
    typeof install.gpu_backend === "string" ? install.gpu_backend.trim().toLowerCase() : "";
  if (raw === "nvidia" || raw === "intel") return raw;
  return install.gpu === true ? "nvidia" : undefined;
}

/**
 * systemd unit value escaping (no newlines).
 * @param {string} arg
 */
function shellQuoteSystemd(arg) {
  if (/[\s"\\]/.test(arg)) {
    return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return arg;
}

/**
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} lms
 */
export function buildSystemdExecStartLine(install, lms) {
  const linuxUser = resolveLinuxUser(install);
  const home = `/home/${linuxUser}`;
  const lmsBlock = isObject(lms) ? lms : {};
  const serverCfg = isObject(lmsBlock.server) ? lmsBlock.server : {};
  const host =
    typeof serverCfg.host === "string" && serverCfg.host.trim() ? serverCfg.host.trim() : "0.0.0.0";
  const port =
    typeof serverCfg.port === "number" && Number.isFinite(serverCfg.port)
      ? Math.trunc(serverCfg.port)
      : Number(serverCfg.port) || 1234;
  const bindLocalhostOnly =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (bindLocalhostOnly) {
    return `${home}/.lmstudio/bin/lms server start`;
  }
  return `${home}/.lmstudio/bin/lms server start --bind ${host} --port ${port}`;
}

/**
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} lms
 */
export function buildInstallShellScript(install, lms) {
  const linuxUser = resolveLinuxUser(install);
  const gpu = install.gpu === true;
  const gpuBackend = resolveGpuBackend(install);
  const home = `/home/${linuxUser}`;
  const lmsBlock = isObject(lms) ? lms : {};
  const loadOnStart =
    typeof lmsBlock.load_on_start === "string" && lmsBlock.load_on_start.trim()
      ? lmsBlock.load_on_start.trim()
      : null;
  const execStart = buildSystemdExecStartLine(install, lms);

  /** @type {string[]} */
  const loadPre = loadOnStart
    ? [`ExecStartPre=${home}/.lmstudio/bin/lms load ${shellQuoteSystemd(loadOnStart)} --yes`]
    : [];

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
    "apt-get install -y -qq curl ca-certificates libatomic1",
    ...nvidiaDriverInstallBlock(gpu, gpuBackend),
    `LINUX_USER=${JSON.stringify(linuxUser)}`,
    `LMS_HOME=${JSON.stringify(home)}`,
    "if ! id \"$LINUX_USER\" >/dev/null 2>&1; then",
    "  useradd -m -s /bin/bash \"$LINUX_USER\"",
    "fi",
    `runuser -u "$LINUX_USER" -- env HOME="$LMS_HOME" bash -lc 'curl -fsSL ${INSTALL_SH_URL} | bash'`,
    'LMS_BIN="$LMS_HOME/.lmstudio/bin/lms"',
    'if [ ! -x "$LMS_BIN" ] && [ -f "$LMS_HOME/.lmstudio-home-pointer" ]; then',
    '  PTR=$(cat "$LMS_HOME/.lmstudio-home-pointer")',
    '  LMS_BIN="$PTR/bin/lms"',
    "fi",
    'test -x "$LMS_BIN"',
    `cat > /etc/systemd/system/lmstudio.service <<'UNIT'`,
    "[Unit]",
    "Description=LM Studio Server (llmster)",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `User=${linuxUser}`,
    `Environment=HOME=${home}`,
    `ExecStartPre=${home}/.lmstudio/bin/lms daemon up`,
    ...loadPre,
    `ExecStart=${execStart}`,
    `ExecStop=${home}/.lmstudio/bin/lms daemon down`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "systemctl daemon-reload",
    "systemctl enable -q lmstudio",
    "systemctl restart lmstudio || systemctl start lmstudio",
  ].join("\n");
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {Record<string, unknown>} opts.install
 * @param {Record<string, unknown>} opts.lms
 */
export async function installLmsInQemu(opts) {
  const { exec, log, install, lms } = opts;
  const gpu = install.gpu === true;
  const gpuBackend = resolveGpuBackend(install);
  const inner = buildInstallShellScript(install, lms);
  log.info(`${exec.label}: installing llmster (LM Studio headless) …`);
  const r = exec.run(inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return {
    ok: true,
    gpu,
    gpu_backend: gpuBackend ?? null,
    linux_user: resolveLinuxUser(install),
    message: "installed",
  };
}
