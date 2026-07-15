import { stderr as errout } from "node:process";

import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { resolvePveSshForHost } from "../../../infrastructure/proxmox/lib/proxmox-pve-ssh.mjs";
import { normalizeInstallBackend } from "./deployments.mjs";

export { resolvePveSshForHost };

const GITHUB_RELEASES = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
const GITHUB_RELEASE_BASE = "https://github.com/ggml-org/llama.cpp/releases/download";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Map install backend to GitHub release asset filename.
 * @param {string} backend
 * @param {string} tag Release tag (e.g. b8485)
 * @param {{ cudaVersion?: string; rocmVersion?: string }} [opts]
 */
export function resolveReleaseAsset(backend, tag, opts = {}) {
  const t = String(tag).trim();
  if (!t) throw new Error("release tag is required");
  const b = normalizeInstallBackend(backend);
  switch (b) {
    case "cpu":
      return `llama-${t}-bin-ubuntu-x64.tar.gz`;
    case "cuda": {
      const v =
        typeof opts.cudaVersion === "string" && opts.cudaVersion.trim()
          ? opts.cudaVersion.trim()
          : "12.4";
      return `llama-${t}-bin-ubuntu-cuda-${v}-x64.tar.gz`;
    }
    case "vulkan":
      return `llama-${t}-bin-ubuntu-vulkan-x64.tar.gz`;
    case "rocm": {
      const v =
        typeof opts.rocmVersion === "string" && opts.rocmVersion.trim()
          ? opts.rocmVersion.trim()
          : "7.2";
      return `llama-${t}-bin-ubuntu-rocm-${v}-x64.tar.gz`;
    }
    default:
      throw new Error(`unknown backend ${backend}`);
  }
}

/**
 * @param {string} tag
 */
export function releaseDownloadUrl(tag, assetName) {
  return `${GITHUB_RELEASE_BASE}/${encodeURIComponent(tag)}/${assetName}`;
}

/**
 * @param {Record<string, unknown>} server
 */
export function serverHasModel(server) {
  if (!isObject(server)) return false;
  const model = typeof server.model === "string" ? server.model.trim() : "";
  const hf = typeof server.hf_model === "string" ? server.hf_model.trim() : "";
  return model.length > 0 || hf.length > 0;
}

/**
 * @param {Record<string, unknown>} server
 * @returns {string[]}
 */
export function buildLlamaServerArgv(server) {
  if (!isObject(server)) {
    return ["--host", "0.0.0.0", "--port", "8080"];
  }
  const host =
    typeof server.host === "string" && server.host.trim() ? server.host.trim() : "0.0.0.0";
  const port =
    typeof server.port === "number" && Number.isFinite(server.port)
      ? server.port
      : Number(server.port) || 8080;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`server.port must be 1–65535 (got ${server.port})`);
  }
  /** @type {string[]} */
  const argv = ["--host", host, "--port", String(Math.trunc(port))];
  const model = typeof server.model === "string" ? server.model.trim() : "";
  const hf = typeof server.hf_model === "string" ? server.hf_model.trim() : "";
  if (model && hf) {
    throw new Error("server.model and server.hf_model are mutually exclusive");
  }
  if (model) argv.push("-m", model);
  if (hf) argv.push("-hf", hf);
  const extra = Array.isArray(server.extra_args) ? server.extra_args : [];
  for (const raw of extra) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const a = raw.trim();
    if (!/^[\w./:=+-]+$/.test(a)) {
      throw new Error(`server.extra_args invalid token ${JSON.stringify(a)}`);
    }
    argv.push(a);
  }
  return argv;
}

/**
 * systemd-safe single argument (no newlines).
 * @param {string} arg
 */
function systemdEscapeArg(arg) {
  if (/[\s"\\]/.test(arg)) {
    return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return arg;
}

/**
 * @param {string[]} argv
 */
export function formatSystemdExecStart(argv) {
  const parts = ["/usr/local/bin/llama-server", ...argv.map(systemdEscapeArg)];
  return parts.join(" ");
}

/**
 * @param {Record<string, unknown>} install
 */
function resolvePinnedRelease(install) {
  const rel = typeof install.release === "string" ? install.release.trim() : "latest";
  return rel.toLowerCase() === "latest" ? null : rel;
}

/**
 * Bash case arms to set ASSET from TAG for a given backend.
 * @param {string} backend
 * @param {string} cudaVersion
 * @param {string} rocmVersion
 */
function assetCaseLines(backend, cudaVersion, rocmVersion) {
  const b = normalizeInstallBackend(backend);
  const arms = {
    cpu: 'ASSET="llama-${TAG}-bin-ubuntu-x64.tar.gz"',
    cuda: `ASSET="llama-\${TAG}-bin-ubuntu-cuda-${cudaVersion}-x64.tar.gz"`,
    vulkan: 'ASSET="llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz"',
    rocm: `ASSET="llama-\${TAG}-bin-ubuntu-rocm-${rocmVersion}-x64.tar.gz"`,
  };
  return [
    `BACKEND=${JSON.stringify(b)}`,
    'case "$BACKEND" in',
    `  cpu) ${arms.cpu} ;;`,
    `  cuda) ${arms.cuda} ;;`,
    `  vulkan) ${arms.vulkan} ;;`,
    `  rocm) ${arms.rocm} ;;`,
    "  *) echo \"unknown backend $BACKEND\" >&2; exit 1 ;;",
    "esac",
  ];
}

/**
 * NVIDIA host drivers for GPU passthrough guests (CUDA and Vulkan backends on Linux).
 * @param {string} backend
 */
export function nvidiaDriverInstallLines(backend) {
  const b = normalizeInstallBackend(backend);
  if (b !== "cuda" && b !== "vulkan") return [];
  return [
    "apt-get install -y -qq ubuntu-drivers-common",
    "DEBIAN_FRONTEND=noninteractive ubuntu-drivers install nvidia || ubuntu-drivers autoinstall",
  ];
}

/**
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} server
 * @param {{ growRootfs?: boolean }} [opts]
 */
export function buildInstallShellScript(install, server, opts = {}) {
  const backend = normalizeInstallBackend(
    typeof install.backend === "string" ? install.backend : "cpu",
  );
  const pinned = resolvePinnedRelease(install);
  const cudaVersion =
    typeof install.cuda_version === "string" && install.cuda_version.trim()
      ? install.cuda_version.trim()
      : "12.4";
  const rocmVersion =
    typeof install.rocm_version === "string" && install.rocm_version.trim()
      ? install.rocm_version.trim()
      : "7.2";

  const modelsDir =
    isObject(server) && typeof server.models_dir === "string" && server.models_dir.trim()
      ? server.models_dir.trim()
      : "/var/lib/llama-cpp/models";

  const argv = buildLlamaServerArgv(isObject(server) ? server : {});
  const execStart = formatSystemdExecStart(argv);
  const startNow = serverHasModel(server);

  /** @type {string[]} */
  const head = ["set -euo pipefail", "export DEBIAN_FRONTEND=noninteractive"];
  if (opts.growRootfs) {
    head.push(
      "ROOT_PART=$(findmnt -n -o SOURCE / | sed 's/[0-9]*$//')",
      "ROOT_NUM=$(findmnt -n -o SOURCE / | grep -oE '[0-9]+$')",
      'if [ -n "$ROOT_PART" ] && [ -n "$ROOT_NUM" ]; then',
      '  growpart "$ROOT_PART" "$ROOT_NUM" 2>/dev/null || true',
      '  resize2fs "$(findmnt -n -o SOURCE /)" 2>/dev/null || true',
      "fi",
    );
  }
  head.push("apt-get update -qq", ...nvidiaDriverInstallLines(backend));
  head.push("apt-get install -y -qq curl ca-certificates tar");

  if (pinned) {
    const asset = resolveReleaseAsset(backend, pinned, { cudaVersion, rocmVersion });
    head.push(`TAG=${JSON.stringify(pinned)}`, 'test -n "$TAG"', `ASSET=${JSON.stringify(asset)}`);
  } else {
    head.push(
      `TAG=$(curl -fsSL ${GITHUB_RELEASES} | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": "\\([^"]*\\)".*/\\1/')`,
      'test -n "$TAG"',
      ...assetCaseLines(backend, cudaVersion, rocmVersion),
    );
  }

  return [
    ...head,
    'URL="' + GITHUB_RELEASE_BASE + '/$TAG/$ASSET"',
    'INSTALL_ROOT="/usr/local/lib/llama-cpp"',
    'INSTALL_DIR="$INSTALL_ROOT/$TAG"',
    'TMP_TAR="/tmp/llama-cpp.tar.gz"',
    'mkdir -p "$INSTALL_DIR"',
    'curl -fL# -o "$TMP_TAR" "$URL"',
    'tar -xf "$TMP_TAR" -C "$INSTALL_DIR"',
    'BIN=$(find "$INSTALL_DIR" -name llama-server -type f | head -1)',
    'test -n "$BIN"',
    'ln -sf "$BIN" /usr/local/bin/llama-server',
    `echo "$TAG" > /opt/llama_cpp_version.txt`,
    "if ! id llamacpp >/dev/null 2>&1; then",
    "  useradd -r -s /usr/sbin/nologin -U -m -d /var/lib/llama-cpp llamacpp 2>/dev/null || useradd -r -s /sbin/nologin -U -m -d /var/lib/llama-cpp llamacpp",
    "fi",
    `mkdir -p ${JSON.stringify(modelsDir)}`,
    `chown -R llamacpp:llamacpp ${JSON.stringify(modelsDir)} /var/lib/llama-cpp 2>/dev/null || true`,
    "cat > /etc/systemd/system/llama-server.service <<'UNIT'",
    "[Unit]",
    "Description=Llama.cpp llama-server",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    "User=llamacpp",
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "systemctl daemon-reload",
    startNow
      ? "systemctl enable -q --now llama-server"
      : "systemctl enable -q llama-server; systemctl stop llama-server 2>/dev/null || true",
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {number} [delayMs]
 */
export async function waitForCt(user, pveHost, vmid, delayMs = 2000) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    errout.write(`[hdc] llama-cpp install: waiting for CT ${vmid} (attempt ${attempt}) …\n`);
    const r = pctExec(user, pveHost, vmid, "true", { capture: true });
    if (r.status === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} server
 */
export async function installLlamaCppInCt(user, pveHost, vmid, install, server) {
  const backend = normalizeInstallBackend(
    typeof install.backend === "string" ? install.backend : "cpu",
  );
  const release =
    typeof install.release === "string" && install.release.trim()
      ? install.release.trim()
      : "latest";
  errout.write(
    `[hdc] llama-cpp install: backend ${backend} release ${release} in CT ${vmid} …\n`,
  );

  await waitForCt(user, pveHost, vmid);

  const inner = buildInstallShellScript(install, server);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, backend, message: `install failed (exit ${r.status})` };
  }

  if (!serverHasModel(server)) {
    errout.write(
      `[hdc] llama-cpp install: ${vmid}: unit installed but not started — set server.model or server.hf_model, then systemctl start llama-server.\n`,
    );
  } else {
    errout.write(`[hdc] llama-cpp install: llama-server started on CT ${vmid}.\n`);
  }
  errout.write(`[hdc] llama-cpp install: completed on CT ${vmid}.\n`);
  return { ok: true, backend, message: "installed" };
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
 * @param {Record<string, unknown>} opts.server
 */
export async function installLlamaCppViaSsh(opts) {
  const { exec, log, install, server } = opts;
  const backend = normalizeInstallBackend(
    typeof install.backend === "string" ? install.backend : "cpu",
  );
  const release =
    typeof install.release === "string" && install.release.trim()
      ? install.release.trim()
      : "latest";
  errout.write(`[hdc] llama-cpp install: backend ${backend} release ${release} via SSH …\n`);
  const inner = buildInstallShellScript(install, server, { growRootfs: true });
  runChecked(exec, inner, log);
  if (!serverHasModel(server)) {
    errout.write(
      `[hdc] llama-cpp install: unit installed but not started — set server.model or server.hf_model, then systemctl start llama-server.\n`,
    );
  } else {
    errout.write(`[hdc] llama-cpp install: llama-server started.\n`);
  }
  errout.write(`[hdc] llama-cpp install: completed via SSH.\n`);
  return { ok: true, backend, message: "installed" };
}
