import { stderr as errout } from "node:process";

import { resolvePveSshForHost } from "../../../infrastructure/proxmox/lib/proxmox-pve-ssh.mjs";
import {
  composeDir,
  hfCacheDir,
  normalizeInstallDevice,
  renderComposeYaml,
  renderEnvFile,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./vllm-render.mjs";

export { resolvePveSshForHost };

/**
 * @returns {string[]}
 */
function dockerCeInstallBlock() {
  return [
    "if ! command -v docker >/dev/null 2>&1; then",
    "  install -m 0755 -d /etc/apt/keyrings",
    "  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "  chmod a+r /etc/apt/keyrings/docker.asc",
    '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME:-$VERSION_ID}) stable" > /etc/apt/sources.list.d/docker.list',
    "  apt-get update -qq",
    "  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin",
    "fi",
    "systemctl enable --now docker",
  ];
}

/**
 * @returns {string[]}
 */
function nvidiaCudaHostBlock() {
  return [
    "apt-get install -y -qq ubuntu-drivers-common || true",
    "NEED_REBOOT=0",
    "if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then",
    "  if ! dpkg -l 'nvidia-driver-*' 2>/dev/null | grep -q '^ii'; then",
    "    DEBIAN_FRONTEND=noninteractive ubuntu-drivers autoinstall || apt-get install -y -qq nvidia-driver-535 || true",
    "    NEED_REBOOT=1",
    "  else",
    "    NEED_REBOOT=1",
    "  fi",
    "fi",
    "if ! dpkg -s nvidia-container-toolkit >/dev/null 2>&1; then",
    "  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
    "  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list",
    "  apt-get update -qq",
    "  apt-get install -y -qq nvidia-container-toolkit",
    "fi",
    "nvidia-ctk runtime configure --runtime=docker",
    "systemctl restart docker",
  ];
}

/**
 * @param {string} composeDirPath
 * @param {string} cacheDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {{ device: "cuda" | "cpu" }} opts
 */
export function buildInstallScript(composeDirPath, cacheDirPath, composeYaml, envContent, opts) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const cache = cacheDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq ca-certificates curl gnupg",
    ...dockerCeInstallBlock(),
  ];
  if (opts.device === "cuda") {
    lines.push(...nvidiaCudaHostBlock());
  }
  lines.push(
    `mkdir -p '${dir}' '${cache}'`,
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
  );
  if (opts.device === "cuda") {
    lines.push(
      'if [ "${NEED_REBOOT:-0}" = "1" ] || ! nvidia-smi >/dev/null 2>&1; then',
      '  echo "HDC_VLLM_NVIDIA_REBOOT_REQUIRED"',
      "  exit 42",
      "fi",
    );
  }
  lines.push(
    `cd '${dir}'`,
    "docker compose pull",
    "docker compose up -d",
    "docker compose ps",
  );
  return lines.join("\n");
}

/**
 * Compose pull/up only (after NVIDIA driver reboot).
 */
export function buildComposeUpScript(composeDirPath, cacheDirPath, composeYaml, envContent) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const cache = cacheDirPath.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `mkdir -p '${dir}' '${cache}'`,
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    "nvidia-smi",
    `cd '${dir}'`,
    "docker compose pull",
    "docker compose up -d",
    "docker compose ps",
  ].join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} cacheDirPath
 * @param {string} composeYaml
 * @param {string} envContent
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export function buildMaintainScript(composeDirPath, cacheDirPath, composeYaml, envContent, opts = {}) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const cache = cacheDirPath.replace(/'/g, `'\\''`);
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${dir}' '${cache}'`,
    `cat > '${dir}/docker-compose.yml' <<'HDCOMPOSE'`,
    composeYaml.trimEnd(),
    "HDCOMPOSE",
    `cat > '${dir}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    `cd '${dir}'`,
  ];
  if (!opts.skipUpgrade) {
    lines.push("docker compose pull");
  }
  lines.push("docker compose up -d", "docker compose ps");
  return lines.join("\n");
}

/**
 * @param {string} composeDirPath
 */
export function buildComposeDownScript(composeDirPath) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `if test -f '${dir}/docker-compose.yml'; then`,
    `  cd '${dir}' && docker compose down 2>/dev/null || true`,
    "fi",
  ].join("\n");
}

/**
 * @param {ReturnType<import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 120)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    const err = new Error(`${exec.label} failed: ${detail.slice(0, 2000)}`);
    /** @type {Error & { status?: number; output?: string }} */
    const enriched = err;
    enriched.status = r.status;
    enriched.output = detail;
    throw enriched;
  }
  return r;
}

/**
 * @param {{
 *   exec: ReturnType<import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>;
 *   log: import("../../../lib/host-provisioner.mjs").ProvisionLog;
 *   install: Record<string, unknown>;
 *   vllm: Record<string, unknown>;
 *   hfToken: string;
 *   guestIp?: string | null;
 *   rebootGuest?: () => Promise<void>;
 *   getExec?: () => ReturnType<import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>;
 * }} opts
 */
export async function installVllmViaSsh(opts) {
  const { log, install, vllm, hfToken, guestIp = null, rebootGuest, getExec } = opts;
  let exec = opts.exec;
  const device = normalizeInstallDevice(
    typeof install.device === "string" ? install.device : "cuda",
  );
  errout.write(`[hdc] vllm install: device ${device} via SSH …\n`);

  const dir = composeDir(install);
  const cache = hfCacheDir(install);
  const envContent = renderEnvFile({ hfToken });
  const composeYaml = renderComposeYaml(install, vllm);
  const inner = buildInstallScript(dir, cache, composeYaml, envContent, { device });
  try {
    runChecked(exec, inner, log);
  } catch (e) {
    const status = /** @type {{ status?: number; output?: string }} */ (e).status;
    const output = String(/** @type {{ output?: string }} */ (e).output || e.message || "");
    if (device === "cuda" && (status === 42 || output.includes("HDC_VLLM_NVIDIA_REBOOT_REQUIRED"))) {
      if (!rebootGuest) {
        throw new Error(
          "NVIDIA driver installed but not loaded — reboot the guest, then re-run deploy --redeploy-existing",
        );
      }
      errout.write(`[hdc] vllm install: NVIDIA driver needs reboot — rebooting guest …\n`);
      await rebootGuest();
      exec = typeof getExec === "function" ? getExec() : exec;
      errout.write(`[hdc] vllm install: resuming docker compose after reboot …\n`);
      runChecked(exec, buildComposeUpScript(dir, cache, composeYaml, envContent), log);
    } else {
      throw e;
    }
  }

  const ip =
    typeof guestIp === "string" && guestIp.trim()
      ? guestIp.trim()
      : null;
  errout.write(`[hdc] vllm install: completed via SSH.\n`);
  return {
    ok: true,
    method: "docker-compose",
    device,
    message: "installed",
    url: resolveWebUrl(vllm, ip),
    upstream_url: resolveUpstreamUrl(ip, vllm),
    guest_ip: ip,
  };
}

/**
 * @param {{
 *   exec: ReturnType<import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>;
 *   log: import("../../../lib/host-provisioner.mjs").ProvisionLog;
 *   install: Record<string, unknown>;
 *   vllm: Record<string, unknown>;
 *   hfToken: string;
 *   guestIp?: string | null;
 *   skipUpgrade?: boolean;
 * }} opts
 */
export async function maintainVllmViaSsh(opts) {
  const { exec, log, install, vllm, hfToken, guestIp = null, skipUpgrade = false } = opts;
  errout.write(`[hdc] vllm maintain: refreshing Compose stack via SSH …\n`);

  const dir = composeDir(install);
  const cache = hfCacheDir(install);
  const envContent = renderEnvFile({ hfToken });
  const composeYaml = renderComposeYaml(install, vllm);
  const inner = buildMaintainScript(dir, cache, composeYaml, envContent, { skipUpgrade });
  runChecked(exec, inner, log);

  const ip = typeof guestIp === "string" && guestIp.trim() ? guestIp.trim() : null;
  return {
    ok: true,
    message: skipUpgrade ? "restarted" : "images refreshed",
    url: resolveWebUrl(vllm, ip),
    upstream_url: resolveUpstreamUrl(ip, vllm),
    guest_ip: ip,
  };
}

/**
 * @param {{
 *   exec: ReturnType<import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>;
 *   install: Record<string, unknown>;
 * }} opts
 */
export function composeDownViaSsh(opts) {
  const { exec, install } = opts;
  const dir = composeDir(install);
  const inner = buildComposeDownScript(dir);
  exec.run(inner, { capture: true });
}
