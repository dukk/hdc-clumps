import { isProxmoxConfigObject } from "./proxmox-config.mjs";
import {
  DEFAULT_UBUNTU_LTS_RELEASE,
  ubuntuLtsByRelease,
} from "./ubuntu-lts-catalog.mjs";

/**
 * @param {unknown} cfg
 */
export function lxcTemplateStorageFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return "local";
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return "local";
  const lxc = provision.lxc;
  if (!isProxmoxConfigObject(lxc)) return "local";
  if (typeof lxc.ostemplate_storage === "string" && lxc.ostemplate_storage.trim()) {
    return lxc.ostemplate_storage.trim();
  }
  if (typeof lxc.storage === "string" && lxc.storage.trim()) {
    const s = lxc.storage.trim();
    const parsed = s.includes(":") ? s.split(":")[0] : s;
    return parsed || "local";
  }
  const ostemplate = typeof lxc.ostemplate === "string" ? lxc.ostemplate : "";
  const m = ostemplate.match(/^([^:]+):vztmpl\//);
  return m?.[1] ? m[1] : "local";
}

/**
 * @param {unknown} cfg
 */
export function defaultUbuntuLtsReleaseFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return DEFAULT_UBUNTU_LTS_RELEASE;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return DEFAULT_UBUNTU_LTS_RELEASE;
  for (const block of [provision.lxc, provision.qemu]) {
    if (!isProxmoxConfigObject(block)) continue;
    const r = typeof block.default_release === "string" ? block.default_release.trim() : "";
    if (r && ubuntuLtsByRelease(r)) return r;
  }
  return DEFAULT_UBUNTU_LTS_RELEASE;
}

/**
 * @param {unknown} cfg
 * @param {import("./ubuntu-lts-catalog.mjs").UbuntuLtsRelease} entry
 */
export function qemuBuildSpecForUbuntuLts(cfg, entry) {
  if (!isProxmoxConfigObject(cfg)) return null;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return null;
  const qemu = provision.qemu;
  if (!isProxmoxConfigObject(qemu)) return null;
  if (qemu.build_template === false || qemu.build_template === 0) return null;

  const storage =
    typeof qemu.storage === "string" && qemu.storage.trim() ? qemu.storage.trim() : "local-lvm";
  const imageStorage =
    typeof qemu.image_storage === "string" && qemu.image_storage.trim()
      ? qemu.image_storage.trim()
      : "local";

  return {
    templateVmid: entry.qemuTemplateVmid,
    templateName: entry.qemuTemplateName,
    storage,
    imageStorage,
    cloudImageUrl: entry.cloudImageUrl,
    cloudImageFilename: entry.cloudImageFilename,
    memoryMb:
      typeof qemu.memory_mb === "number" && Number.isFinite(qemu.memory_mb) ? qemu.memory_mb : 2048,
    cores: typeof qemu.cores === "number" && Number.isFinite(qemu.cores) ? qemu.cores : 2,
    bridge: typeof qemu.bridge === "string" && qemu.bridge.trim() ? qemu.bridge.trim() : "vmbr0",
    release: entry.release,
  };
}

const DEFAULT_FIRST_BOOT_SETTLE_MS = 45_000;
const DEFAULT_FIRST_BOOT_PROBE_MS = 90_000;
const DEFAULT_FIRST_BOOT_SSH_TIMEOUT_MS = 300_000;

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveSecondsToMs(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.round(value * 1000);
}

/**
 * QEMU first-boot SSH wait timing from provision.qemu.first_boot.
 * @param {unknown} cfg
 * @returns {{
 *   settleMs: number;
 *   sshProbeMs: number;
 *   sshTimeoutMs: number;
 *   rebootOnProbeFail: boolean;
 * }}
 */
export function qemuFirstBootWaitOptsFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) {
    return {
      settleMs: DEFAULT_FIRST_BOOT_SETTLE_MS,
      sshProbeMs: DEFAULT_FIRST_BOOT_PROBE_MS,
      sshTimeoutMs: DEFAULT_FIRST_BOOT_SSH_TIMEOUT_MS,
      rebootOnProbeFail: true,
    };
  }
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) {
    return {
      settleMs: DEFAULT_FIRST_BOOT_SETTLE_MS,
      sshProbeMs: DEFAULT_FIRST_BOOT_PROBE_MS,
      sshTimeoutMs: DEFAULT_FIRST_BOOT_SSH_TIMEOUT_MS,
      rebootOnProbeFail: true,
    };
  }
  const qemu = provision.qemu;
  if (!isProxmoxConfigObject(qemu)) {
    return {
      settleMs: DEFAULT_FIRST_BOOT_SETTLE_MS,
      sshProbeMs: DEFAULT_FIRST_BOOT_PROBE_MS,
      sshTimeoutMs: DEFAULT_FIRST_BOOT_SSH_TIMEOUT_MS,
      rebootOnProbeFail: true,
    };
  }
  const firstBoot = qemu.first_boot;
  if (!isProxmoxConfigObject(firstBoot)) {
    return {
      settleMs: DEFAULT_FIRST_BOOT_SETTLE_MS,
      sshProbeMs: DEFAULT_FIRST_BOOT_PROBE_MS,
      sshTimeoutMs: DEFAULT_FIRST_BOOT_SSH_TIMEOUT_MS,
      rebootOnProbeFail: true,
    };
  }

  const rebootOnProbeFail =
    firstBoot.reboot_on_probe_fail === false || firstBoot.reboot_on_probe_fail === 0
      ? false
      : true;

  return {
    settleMs: positiveSecondsToMs(firstBoot.settle_seconds, DEFAULT_FIRST_BOOT_SETTLE_MS),
    sshProbeMs: positiveSecondsToMs(firstBoot.ssh_probe_seconds, DEFAULT_FIRST_BOOT_PROBE_MS),
    sshTimeoutMs: positiveSecondsToMs(firstBoot.ssh_timeout_seconds, DEFAULT_FIRST_BOOT_SSH_TIMEOUT_MS),
    rebootOnProbeFail,
  };
}
