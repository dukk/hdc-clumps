import { Buffer } from "node:buffer";

import { pveData, pveJsonRequest } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { startQemuGuest } from "../../bind/lib/proxmox-qemu-redeploy.mjs";

import { forceStopHaosQemuGuest } from "./haos-qemu-lifecycle.mjs";
import { resolveHaosImportedDiskVolume } from "./proxmox-haos-vm.mjs";
import { waitForHomeAssistantHttp } from "./query-status.mjs";

export const HDC_REVERSE_PROXY_BEGIN = "# hdc: reverse-proxy begin";
export const HDC_REVERSE_PROXY_END = "# hdc: reverse-proxy end";
export const HAOS_CONFIG_REL_PATH = "supervisor/homeassistant/configuration.yaml";
export const HAOS_DATA_PARTITION = 8;

/**
 * @param {string} volumeRef e.g. local-lvm:vm-121-disk-1
 */
export function proxmoxVolumeToDevPath(volumeRef) {
  const vol = String(volumeRef ?? "")
    .split(",")[0]
    .trim();
  const name = vol.includes(":") ? vol.split(":").pop() : vol;
  if (!name) throw new Error(`invalid Proxmox volume ref: ${JSON.stringify(volumeRef)}`);
  return `/dev/pve/${name}`;
}

/**
 * @param {object} opts
 * @param {string[]} opts.trustedProxies
 */
export function buildReverseProxyConfigurationBlock(opts) {
  const proxies = Array.isArray(opts.trustedProxies)
    ? opts.trustedProxies.map((v) => String(v).trim()).filter(Boolean)
    : [];
  if (!proxies.length) {
    throw new Error("trusted_proxies requires at least one nginx-waf IP (inventory or homeassistant.trusted_proxies)");
  }

  // Only manage http.trusted_proxies. Do not emit a homeassistant: key — that locks
  // General settings (location, etc.) in the HA UI. Set external/internal URLs under
  // Settings → System → Network instead.
  const lines = [HDC_REVERSE_PROXY_BEGIN, "http:", "  use_x_forwarded_for: true", "  trusted_proxies:"];
  for (const ip of proxies) {
    lines.push(`    - ${ip}`);
  }

  lines.push(HDC_REVERSE_PROXY_END);
  return `${lines.join("\n")}\n`;
}

/**
 * Remove root-level homeassistant: blocks that only set external_url / internal_url
 * (legacy hdc reverse-proxy fields). Leaves other homeassistant: keys alone.
 * @param {string} content
 */
export function stripOrphanedHomeassistantUrlBlock(content) {
  let text = String(content ?? "");
  // Match a root homeassistant: mapping whose only keys are external_url and/or internal_url.
  text = text.replace(
    /(^|\n)homeassistant:\n(?:  (?:external_url|internal_url):[^\n]*\n)+/g,
    (match, prefix) => {
      const body = match.slice(prefix.length);
      const lines = body
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0);
      // homeassistant: + only url keys
      const keys = lines.slice(1).map((l) => l.match(/^ {2}([a-z_]+):/)?.[1] ?? "");
      if (keys.length === 0) return match;
      if (!keys.every((k) => k === "external_url" || k === "internal_url")) return match;
      return prefix;
    },
  );
  return text;
}

/**
 * @param {string} content
 */
export function stripManagedReverseProxyBlocks(content) {
  let text = String(content ?? "");
  const begin = text.indexOf(HDC_REVERSE_PROXY_BEGIN);
  const end = text.indexOf(HDC_REVERSE_PROXY_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    text = `${text.slice(0, begin)}${text.slice(end + HDC_REVERSE_PROXY_END.length)}`;
  }

  // Legacy manual hdc comment (pre-marker)
  text = text.replace(
    /\n# hdc: nginx-waf reverse proxy[^\n]*\nhttp:\n(?:  [^\n]+\n)*?(?:  trusted_proxies:\n(?:    - [^\n]+\n)+)/g,
    "\n",
  );

  text = stripOrphanedHomeassistantUrlBlock(text);

  return text.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * @param {string} content
 * @param {string} block
 */
export function mergeHomeAssistantConfigurationYaml(content, block) {
  const base = stripManagedReverseProxyBlocks(content);
  const trimmedBlock = String(block ?? "").trimEnd();
  if (!base.trim()) return `${trimmedBlock}\n`;
  return `${base}\n\n${trimmedBlock}\n`;
}

/**
 * @param {string} content
 * @param {object} desired
 * @param {string[]} desired.trustedProxies
 */
export function reverseProxyConfigurationInSync(content, desired) {
  const expected = mergeHomeAssistantConfigurationYaml(
    content,
    buildReverseProxyConfigurationBlock(desired),
  );
  const norm = (s) => `${String(s ?? "").trimEnd()}\n`;
  if (norm(content) !== norm(expected)) return false;
  if (!content.includes(HDC_REVERSE_PROXY_BEGIN)) return false;
  for (const ip of desired.trustedProxies) {
    if (!content.includes(`- ${ip}`)) return false;
  }
  return true;
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 */
/**
 * @param {object} opts
 */
/**
 * @param {object} opts
 * @param {number} [timeoutMs]
 */
async function waitForQemuStopped(opts, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await qemuGuestIsRunning(opts))) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`QEMU ${opts.vmid} still running after ${timeoutMs}ms`);
}

async function qemuGuestIsRunning(opts) {
  const path = `/nodes/${encodeURIComponent(opts.node)}/qemu/${encodeURIComponent(String(opts.vmid))}/status/current`;
  const body = await pveJsonRequest(
    "GET",
    opts.apiBase,
    path,
    opts.authorization,
    opts.rejectUnauthorized,
  );
  const data = pveData(body);
  return data && typeof data === "object" && !Array.isArray(data) && data.status === "running";
}

async function fetchQemuConfig(opts) {
  const configPath = `/nodes/${encodeURIComponent(opts.node)}/qemu/${encodeURIComponent(String(opts.vmid))}/config`;
  const body = await pveJsonRequest(
    "GET",
    opts.apiBase,
    configPath,
    opts.authorization,
    opts.rejectUnauthorized,
  );
  const data = pveData(body);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`invalid qemu config for vmid ${opts.vmid}`);
  }
  return /** @type {Record<string, unknown>} */ (data);
}

/**
 * @param {object} opts
 * @param {string} opts.sshUser
 * @param {string} opts.sshHost
 * @param {number} opts.vmid
 * @param {string} opts.diskDev
 * @param {string} [opts.mode] read | write
 * @param {string} [opts.newContent] required for write
 */
function runHaosConfigDiskRemote(opts) {
  const mount = `/mnt/hdc-haos-config-${opts.vmid}`;
  const cfg = `${mount}/${HAOS_CONFIG_REL_PATH}`;
  const mode = opts.mode === "write" ? "write" : "read";
  const b64 =
    mode === "write" && typeof opts.newContent === "string"
      ? Buffer.from(opts.newContent, "utf8").toString("base64")
      : "";

  const script = [
    "set -euo pipefail",
    `VMID=${opts.vmid}`,
    `DISK='${opts.diskDev.replace(/'/g, `'\\''`)}'`,
    `MOUNT='${mount}'`,
    `CFG='${cfg}'`,
    `PART=${HAOS_DATA_PARTITION}`,
    "for _i in $(seq 1 30); do qm status \"$VMID\" 2>/dev/null | grep -qw stopped && break; sleep 2; done",
    "qm status \"$VMID\" 2>/dev/null | grep -qw stopped || { echo \"VM $VMID not stopped before disk mount\" >&2; exit 1; }",
    "LOOP=''",
    "cleanup() {",
    "  if mountpoint -q \"$MOUNT\" 2>/dev/null; then umount \"$MOUNT\" || true; fi",
    "  if [ -n \"$LOOP\" ] && losetup \"$LOOP\" >/dev/null 2>&1; then losetup -d \"$LOOP\" || true; fi",
    "  rmdir \"$MOUNT\" 2>/dev/null || true",
    "}",
    "trap cleanup EXIT",
    "mkdir -p \"$MOUNT\"",
    "losetup -d \"$DISK\" 2>/dev/null || true",
    "LOOP=$(losetup -Pf --show \"$DISK\")",
    'if [ ! -b "${LOOP}p${PART}" ]; then',
    '  partprobe "$LOOP" 2>/dev/null || partx -a "$LOOP" 2>/dev/null || true',
    "fi",
    'if [ -b "${LOOP}p${PART}" ]; then',
    `  mount -o ${mode === "read" ? "ro" : "rw"} \"\${LOOP}p\${PART}\" \"$MOUNT\"`,
    "else",
    '  START=$(fdisk -l "$DISK" 2>/dev/null | awk -v p="$PART" \'$1 ~ ("p" p "$") { print $2; exit }\')',
    '  if [ -z "$START" ]; then',
    '    echo "partition $PART start sector not found on $DISK" >&2',
    "    exit 1",
    "  fi",
    `  mount -o ${mode === "read" ? "ro" : "rw"},offset=\$((START * 512)) \"$DISK\" \"$MOUNT\"`,
    "fi",
    mode === "read" ? "cat \"$CFG\"" : [
      `echo '${b64}' | base64 -d > \"$CFG\"`,
      "sync",
      'echo "wrote_ok"',
    ].join("\n"),
  ].join("\n");

  return sshRemote(opts.sshUser, opts.sshHost, script, { capture: true });
}

/**
 * Apply or refresh nginx-waf reverse-proxy settings in HAOS configuration.yaml.
 *
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.storage
 * @param {string} opts.sshUser
 * @param {string} opts.sshHost
 * @param {string} opts.ipHost Guest LAN IP without prefix
 * @param {string[]} opts.trustedProxies
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} [opts.log]
 */
export async function applyHaosReverseProxyConfig(opts) {
  const log = opts.log ?? (() => {});
  const desired = {
    trustedProxies: opts.trustedProxies,
  };

  const config = await fetchQemuConfig({
    apiBase: opts.apiBase,
    node: opts.node,
    vmid: opts.vmid,
    authorization: opts.authorization,
    rejectUnauthorized: opts.rejectUnauthorized,
  });
  const volume = resolveHaosImportedDiskVolume(config, opts.storage, opts.vmid);
  const diskDev = proxmoxVolumeToDevPath(volume);

  if (opts.dryRun) {
    log(
      `dry-run: would sync reverse-proxy configuration on ${diskDev} (brief VM stop required when not dry-run)`,
    );
    return {
      changed: false,
      dry_run: true,
      trusted_proxies: desired.trustedProxies,
      disk_dev: diskDev,
    };
  }

  const wasRunning = await qemuGuestIsRunning({
    apiBase: opts.apiBase,
    node: opts.node,
    vmid: opts.vmid,
    authorization: opts.authorization,
    rejectUnauthorized: opts.rejectUnauthorized,
  });

  log(`stopping VM ${opts.vmid} to update reverse-proxy configuration …`);
  await forceStopHaosQemuGuest({
    apiBase: opts.apiBase,
    authorization: opts.authorization,
    rejectUnauthorized: opts.rejectUnauthorized,
    node: opts.node,
    vmid: opts.vmid,
    sshUser: opts.sshUser,
    sshHost: opts.sshHost,
    log,
  });
  await waitForQemuStopped({
    apiBase: opts.apiBase,
    node: opts.node,
    vmid: opts.vmid,
    authorization: opts.authorization,
    rejectUnauthorized: opts.rejectUnauthorized,
  });
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const read = runHaosConfigDiskRemote({
    sshUser: opts.sshUser,
    sshHost: opts.sshHost,
    vmid: opts.vmid,
    diskDev,
    mode: "read",
  });
  if (read.status !== 0) {
    throw new Error(
      `read HA configuration.yaml failed (${read.status}): ${read.stderr.trim() || read.stdout.trim()}`,
    );
  }

  const current = read.stdout;
  const block = buildReverseProxyConfigurationBlock(desired);
  if (reverseProxyConfigurationInSync(current, desired)) {
    log("reverse-proxy configuration already in sync — skipping write");
    await startQemuGuest({
      apiBase: opts.apiBase,
      authorization: opts.authorization,
      rejectUnauthorized: opts.rejectUnauthorized,
      node: opts.node,
      vmid: opts.vmid,
      log,
    });
    return {
      changed: false,
      trusted_proxies: desired.trustedProxies,
      disk_dev: diskDev,
    };
  }

  const merged = mergeHomeAssistantConfigurationYaml(current, block);

  log(`writing configuration.yaml on ${diskDev} (partition ${HAOS_DATA_PARTITION}) …`);
  const write = runHaosConfigDiskRemote({
    sshUser: opts.sshUser,
    sshHost: opts.sshHost,
    vmid: opts.vmid,
    diskDev,
    mode: "write",
    newContent: merged,
  });
  if (write.status !== 0 || !write.stdout.includes("wrote_ok")) {
    throw new Error(
      `write HA configuration.yaml failed (${write.status}): ${write.stderr.trim() || write.stdout.trim()}`,
    );
  }

  log(`starting VM ${opts.vmid} after configuration update …`);
  await startQemuGuest({
    apiBase: opts.apiBase,
    authorization: opts.authorization,
    rejectUnauthorized: opts.rejectUnauthorized,
    node: opts.node,
    vmid: opts.vmid,
    log,
  });

  log(`waiting for Home Assistant on http://${opts.ipHost}:8123/ …`);
  const http = await waitForHomeAssistantHttp({
    host: opts.ipHost,
    timeoutMs: 300_000,
    log,
  });

  return {
    changed: true,
    trusted_proxies: desired.trustedProxies,
    disk_dev: diskDev,
    http,
  };
}
