import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isProxmoxConfigObject, loadProxmoxHostsByCluster } from "./proxmox-config.mjs";
import { parseSshUrl } from "hdc/cli/lib/users-bootstrap-hdc.mjs";
import {
  discoverLocalSshMaterial,
  sshReachableWithPubkey,
  sshSpawn,
} from "hdc/cli/lib/ssh-host-access.mjs";

const DEFAULT_REBOOT_WAIT_MS = 5 * 60 * 1000;

/**
 * @param {unknown} cfg
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ id: string; user: string; host: string; clusterId: string | null }[]}
 */
export function listProxmoxHypervisorSshTargets(cfg, env) {
  /** @type {Map<string, { id: string; user: string; host: string; clusterId: string | null }>} */
  const byId = new Map();
  if (!isProxmoxConfigObject(cfg)) return [];

  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: "",
    configRel: "",
    onSkip: () => {},
  });

  for (const members of byCluster.values()) {
    for (const m of members) {
      if (byId.has(m.id)) continue;
      const ssh = typeof m.host.ssh === "string" ? m.host.ssh : "";
      const parsed = parseSshUrl(ssh);
      if (!parsed?.host) continue;
      const user =
        parsed.user ??
        (typeof env.HDC_PROXMOX_SSH_USER === "string" && env.HDC_PROXMOX_SSH_USER.trim()
          ? env.HDC_PROXMOX_SSH_USER.trim()
          : null);
      if (!user) continue;
      byId.set(m.id, { id: m.id, user, host: parsed.host, clusterId: m.clusterId });
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * @param {unknown} cfg
 */
export function hostOsMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return true;
  const hostOs = provision.host_os;
  if (!isProxmoxConfigObject(hostOs)) return true;
  return hostOs.enabled !== false && hostOs.enabled !== 0;
}

/**
 * @param {unknown} cfg
 */
export function hostOsRebootWaitMsFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return DEFAULT_REBOOT_WAIT_MS;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return DEFAULT_REBOOT_WAIT_MS;
  const hostOs = provision.host_os;
  if (!isProxmoxConfigObject(hostOs)) return DEFAULT_REBOOT_WAIT_MS;
  const sec = hostOs.reboot_wait_seconds;
  if (typeof sec === "number" && Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  return DEFAULT_REBOOT_WAIT_MS;
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {{ user: string; host: string }} target
 * @param {string[]} remoteArgv
 * @param {typeof import("node:child_process").spawnSync} spawnSync
 * @param {NodeJS.ProcessEnv} env
 * @param {{ privateKey: string; certificateFile?: string }[]} identities
 * @param {number} [timeoutMs]
 */
function sshExec(target, remoteArgv, spawnSync, env, identities, timeoutMs = 600_000) {
  return sshSpawn(target, remoteArgv, {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs,
  });
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {number} [opts.rebootWaitMs]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function runProxmoxHostOsMaintain(opts) {
  const {
    clumpRoot,
    log,
    warn,
    dryRun,
    env,
    spawnSync,
    rebootWaitMs = DEFAULT_REBOOT_WAIT_MS,
  } = opts;

  const configPath = join(clumpRoot, "config.json");
  if (!existsSync(configPath)) {
    warn("host OS maintain: missing config.json — skip.");
    return { ok: true };
  }

  /** @type {unknown} */
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    warn(`host OS maintain: invalid config.json: ${/** @type {Error} */ (e).message}`);
    return { ok: false };
  }

  if (!hostOsMaintainEnabledFromConfig(cfg)) {
    log("host OS maintain: disabled in provision.host_os.enabled — skip.");
    return { ok: true };
  }

  const targets = listProxmoxHypervisorSshTargets(cfg, env);
  if (!targets.length) {
    warn("host OS maintain: no clusters[].hosts[] with ssh:// URLs — skip.");
    return { ok: true };
  }

  const { identities } = discoverLocalSshMaterial();

  log(`host OS maintain: ${targets.length} hypervisor(s); reboot wait up to ${Math.round(rebootWaitMs / 1000)}s each.`);

  let ok = true;

  for (const target of targets) {
    const label = `${target.id} (${target.user}@${target.host})`;
    log(`[${target.id}] checking SSH to ${target.user}@${target.host} …`);
    if (!dryRun && !sshReachableWithPubkey(target, spawnSync, env, identities)) {
      ok = false;
      warn(
        `[${target.id}] SSH public-key auth failed — run maintain without --skip-ssh-keys first, or check ~/.ssh keys.`,
      );
      continue;
    }

    if (dryRun) {
      log(`[${target.id}] dry-run: would apt update && dist-upgrade on ${label}.`);
      log(`[${target.id}] dry-run: would reboot if /var/run/reboot-required exists.`);
      continue;
    }

    log(`[${target.id}] apt update && dist-upgrade …`);
    const upgrade = sshExec(
      target,
      [
        "bash",
        "-lc",
        "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get dist-upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold",
      ],
      spawnSync,
      env,
      identities,
    );
    if (upgrade.status !== 0) {
      ok = false;
      const err = `${upgrade.stderr ?? ""}${upgrade.stdout ?? ""}`.trim();
      warn(`[${target.id}] apt dist-upgrade failed (status ${upgrade.status ?? "?"}): ${err || "no output"}`);
      continue;
    }
    log(`[${target.id}] apt dist-upgrade finished.`);

    const rebootCheck = sshExec(target, ["test", "-f", "/var/run/reboot-required"], spawnSync, env, identities, 30_000);
    const needsReboot = rebootCheck.status === 0;
    if (!needsReboot) {
      log(`[${target.id}] no reboot required.`);
      continue;
    }

    log(`[${target.id}] reboot required — rebooting now (next host waits until this node is back) …`);
    sshExec(target, ["systemctl", "reboot"], spawnSync, env, identities, 15_000);
    await sleep(15_000);

    const deadline = Date.now() + rebootWaitMs;
    let back = false;
    while (Date.now() < deadline) {
      if (sshReachableWithPubkey(target, spawnSync, env, identities)) {
        back = true;
        break;
      }
      log(`[${target.id}] waiting for SSH …`);
      await sleep(10_000);
    }

    if (back) {
      log(`[${target.id}] back online after reboot.`);
    } else {
      ok = false;
      warn(`[${target.id}] did not return via SSH within ${Math.round(rebootWaitMs / 1000)}s after reboot.`);
    }
  }

  return { ok };
}
