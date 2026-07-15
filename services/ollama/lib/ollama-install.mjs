import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { resolvePveSshForHost } from "../../../infrastructure/proxmox/lib/proxmox-pve-ssh.mjs";

export { resolvePveSshForHost };

const GITHUB_RELEASES = "https://api.github.com/repos/ollama/ollama/releases/latest";

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {number} [maxAttempts]
 * @param {number} [delayMs]
 */
export async function waitForCt(user, pveHost, vmid, maxAttempts = 30, delayMs = 2000) {
  for (let i = 1; i <= maxAttempts; i++) {
    errout.write(`[hdc] ollama install: waiting for CT ${vmid} (attempt ${i}/${maxAttempts}) …\n`);
    const r = pctExec(user, pveHost, vmid, "true", { capture: true });
    if (r.status === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

/**
 * @param {Record<string, unknown>} install
 */
function installMethod(install) {
  const m = typeof install.method === "string" ? install.method.trim().toLowerCase() : "";
  return m === "curl-install-sh" ? "curl-install-sh" : "github-release";
}

/**
 * @param {boolean} gpu
 */
function githubReleaseInstallScript(gpu) {
  const gpuLines = gpu
    ? [
        "Environment=OLLAMA_INTEL_GPU=true",
        "Environment=OLLAMA_NUM_GPU=999",
        "Environment=SYCL_CACHE_PERSISTENT=1",
        "Environment=ZES_ENABLE_SYSMAN=1",
      ]
    : [];
  const gpuBlock = gpuLines.length ? `${gpuLines.join("\n")}\n` : "";
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
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
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} install
 */
export async function installOllamaInCt(user, pveHost, vmid, install) {
  const method = installMethod(install);
  const gpu = install.gpu === true;
  errout.write(`[hdc] ollama install: method ${method}${gpu ? " (gpu env)" : ""} in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid);
  if (!ready) {
    return { ok: false, method, message: `CT ${vmid} not reachable via pct exec` };
  }

  const inner = method === "curl-install-sh" ? curlInstallShScript() : githubReleaseInstallScript(gpu);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, method, message: `install failed (exit ${r.status})` };
  }
  errout.write(`[hdc] ollama install: completed on CT ${vmid}.\n`);
  return { ok: true, method, message: "installed" };
}
