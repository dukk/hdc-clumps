import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";

const GITHUB_RELEASES = "https://api.github.com/repos/ollama/ollama/releases/latest";

/**
 * @param {Record<string, unknown>} install
 */
function installMethod(install) {
  const m = typeof install.method === "string" ? install.method.trim().toLowerCase() : "";
  return m === "curl-install-sh" ? "curl-install-sh" : "github-release";
}

/**
 * @param {boolean} gpu
 * @param {"nvidia" | "intel" | undefined} gpuBackend
 */
function ollamaServiceGpuEnvLines(gpu, gpuBackend) {
  if (!gpu) return [];
  if (gpuBackend === "nvidia") {
    return [];
  }
  return [
    "Environment=OLLAMA_INTEL_GPU=true",
    "Environment=OLLAMA_NUM_GPU=999",
    "Environment=SYCL_CACHE_PERSISTENT=1",
    "Environment=ZES_ENABLE_SYSMAN=1",
  ];
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
 * @param {boolean} gpu
 * @param {"nvidia" | "intel" | undefined} gpuBackend
 */
function githubReleaseInstallScript(gpu, gpuBackend) {
  const gpuLines = ollamaServiceGpuEnvLines(gpu, gpuBackend);
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
    ...nvidiaDriverInstallBlock(gpu, gpuBackend),
    "apt-get install -y -qq curl zstd ca-certificates",
    `RELEASE=$(curl -fsSL ${GITHUB_RELEASES} | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": "\\([^"]*\\)".*/\\1/')`,
    'OLLAMA_INSTALL_DIR="/usr/local/lib/ollama"',
    'BINDIR="/usr/local/bin"',
    'mkdir -p "$OLLAMA_INSTALL_DIR"',
    'OLLAMA_URL="https://github.com/ollama/ollama/releases/download/${RELEASE}/ollama-linux-amd64.tar.zst"',
    'TMP_TAR="/tmp/ollama.tar.zst"',
    'curl -fL# -o "$TMP_TAR" "$OLLAMA_URL"',
    'tar --zstd -xf "$TMP_TAR" -C "$OLLAMA_INSTALL_DIR"',
    'ln -sf "$OLLAMA_INSTALL_DIR/bin/ollama" "$BINDIR/ollama"',
    'echo "$RELEASE" > /opt/Ollama_version.txt',
    "if ! id ollama >/dev/null 2>&1; then",
    "  useradd -r -s /usr/sbin/nologin -U -m -d /usr/share/ollama ollama 2>/dev/null || useradd -r -s /sbin/nologin -U -m -d /usr/share/ollama ollama",
    "fi",
    "cat > /etc/systemd/system/ollama.service <<'UNIT'",
    "[Unit]",
    "Description=Ollama Service",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    "ExecStart=/usr/local/bin/ollama serve",
    "Environment=HOME=/usr/share/ollama",
    "Environment=OLLAMA_HOST=0.0.0.0",
    ...gpuLines,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "systemctl daemon-reload",
    "systemctl enable -q --now ollama",
  ].join("\n");
}

function curlInstallShScript() {
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq curl ca-certificates",
    "curl -fsSL https://ollama.com/install.sh | sh",
    "systemctl enable -q --now ollama 2>/dev/null || true",
  ].join("\n");
}

/**
 * @param {Record<string, unknown>} install
 */
function resolveGpuBackend(install) {
  const raw =
    typeof install.gpu_backend === "string" ? install.gpu_backend.trim().toLowerCase() : "";
  if (raw === "nvidia" || raw === "intel") return raw;
  return install.gpu === true ? "intel" : undefined;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 120)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return r;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {Record<string, unknown>} opts.install
 */
export async function installOllamaInQemu(opts) {
  const { exec, log, install } = opts;
  const method = installMethod(install);
  const gpu = install.gpu === true;
  const gpuBackend = resolveGpuBackend(install);
  const inner =
    method === "curl-install-sh"
      ? curlInstallShScript()
      : githubReleaseInstallScript(gpu, gpuBackend);
  runChecked(exec, inner, log);
  return {
    ok: true,
    method,
    gpu,
    gpu_backend: gpuBackend ?? null,
    message: "installed",
  };
}
