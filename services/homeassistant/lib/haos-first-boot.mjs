import { qemuFirstBootWaitOptsFromConfig } from "../../../infrastructure/proxmox/lib/proxmox-provision-config.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { restartHaosQemuGuest } from "./haos-qemu-lifecycle.mjs";
import { probeHomeAssistantHttp } from "./query-status.mjs";

/**
 * @param {object} opts
 * @param {unknown} [opts.proxmoxCfg]
 * @param {string} [opts.proxmoxPackageRoot]
 * @param {Record<string, string>} [opts.flags]
 */
function resolveHaosFirstBootTiming(opts) {
  const flags = opts.flags ?? {};
  if (flagGet(flags, "skip-first-boot-restart", "skip_first_boot_restart") !== undefined) {
    return { settleMs: 0, probeMs: 0, restartOnProbeFail: false };
  }

  let proxmoxCfg = opts.proxmoxCfg;
  if (!proxmoxCfg && typeof opts.proxmoxPackageRoot === "string" && opts.proxmoxPackageRoot.trim()) {
    try {
      proxmoxCfg = loadClumpConfigFromClumpRoot(opts.proxmoxPackageRoot.trim()).data;
    } catch {
      proxmoxCfg = undefined;
    }
  }

  const cfgOpts = proxmoxCfg ? qemuFirstBootWaitOptsFromConfig(proxmoxCfg) : null;
  return {
    settleMs: cfgOpts?.settleMs ?? 45_000,
    probeMs: cfgOpts?.sshProbeMs ?? 90_000,
    restartOnProbeFail: true,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After first start, probe HTTP and force-restart when HAOS is still down (serial-console hang workaround).
 *
 * @param {object} opts
 * @param {string} opts.host Guest IP (no CIDR)
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} [opts.sshUser]
 * @param {string} [opts.sshHost]
 * @param {unknown} [opts.proxmoxCfg]
 * @param {string} [opts.proxmoxPackageRoot]
 * @param {Record<string, string>} [opts.flags]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ restarted: boolean; probe: Awaited<ReturnType<typeof probeHomeAssistantHttp>> }>}
 */
export async function maybeRestartHaosAfterFirstBoot(opts) {
  const log = opts.log ?? (() => {});
  const timing = resolveHaosFirstBootTiming(opts);

  if (!timing.restartOnProbeFail) {
    return { restarted: false, probe: await probeHomeAssistantHttp(opts.host) };
  }

  if (timing.settleMs > 0) {
    log(`waiting ${Math.round(timing.settleMs / 1000)}s before first-boot HTTP probe …`);
    await sleep(timing.settleMs);
  }

  log(`probing http://${opts.host}:8123/ (up to ${Math.round(timing.probeMs / 1000)}s) …`);
  const deadline = Date.now() + timing.probeMs;
  let probe = await probeHomeAssistantHttp(opts.host, 8123, 8000);
  while (!probe.ok && Date.now() < deadline) {
    await sleep(15_000);
    probe = await probeHomeAssistantHttp(opts.host, 8123, 8000);
  }

  if (probe.ok) {
    return { restarted: false, probe };
  }

  log(
    `HTTP not ready — force-restarting QEMU ${opts.vmid} on ${opts.node} (HAOS first-boot workaround) …`,
  );
  await restartHaosQemuGuest({
    apiBase: opts.apiBase,
    authorization: opts.authorization,
    rejectUnauthorized: opts.rejectUnauthorized,
    node: opts.node,
    vmid: opts.vmid,
    sshUser: opts.sshUser,
    sshHost: opts.sshHost,
    log,
  });

  return { restarted: true, probe };
}
