import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { createConfigureExec } from "../../../services/postfix-relay/lib/postfix-relay-configure.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { ensurePostfixSatellite } from "hdc/package/postfix-satellite-ensure.mjs";
import { isProxmoxConfigObject } from "./proxmox-config.mjs";
import {
  hostOsMaintainEnabledFromConfig,
  listProxmoxHypervisorSshTargets,
} from "./proxmox-host-os-maintain.mjs";
import {
  discoverLocalSshMaterial,
  sshReachableWithPubkey,
} from "hdc/cli/lib/ssh-host-access.mjs";

/**
 * @param {unknown} cfg
 * @returns {boolean}
 */
export function mailRelayMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return true;
  const hostOs = provision.host_os;
  if (!isProxmoxConfigObject(hostOs)) return true;
  if (hostOs.enabled === false || hostOs.enabled === 0) return false;
  const mailRelay = hostOs.mail_relay;
  if (mailRelay === false || mailRelay === 0) return false;
  if (isProxmoxConfigObject(mailRelay) && (mailRelay.enabled === false || mailRelay.enabled === 0)) {
    return false;
  }
  return true;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @returns {Promise<{ ok: boolean; hosts: Record<string, unknown>[] }>}
 */
export async function runProxmoxMailRelayMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, env, spawnSync } = opts;

  /** @type {unknown} */
  let cfg;
  try {
    const loaded = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: "clumps/infrastructure/proxmox/config.example.json",
    });
    cfg = loaded.data;
  } catch {
    warn("mail relay maintain: missing config — skip.");
    return { ok: true, hosts: [] };
  }

  if (!mailRelayMaintainEnabledFromConfig(cfg)) {
    log("mail relay maintain: disabled in provision.host_os.mail_relay — skip.");
    return { ok: true, hosts: [] };
  }

  const targets = listProxmoxHypervisorSshTargets(cfg, env);
  if (!targets.length) {
    warn("mail relay maintain: no clusters[].hosts[] with ssh:// URLs — skip.");
    return { ok: true, hosts: [] };
  }

  const { identities } = discoverLocalSshMaterial();
  const plog = provisionLogFromConsole(console);

  /** @type {Record<string, unknown>[]} */
  const hosts = [];
  let ok = true;

  log(`mail relay maintain: ${targets.length} hypervisor(s).`);

  for (const target of targets) {
    const row = {
      id: target.id,
      host: target.host,
      user: target.user,
    };

    if (dryRun) {
      log(`[${target.id}] dry-run: would configure Postfix satellite on ${target.user}@${target.host}.`);
      row.ok = true;
      row.dry_run = true;
      hosts.push(row);
      continue;
    }

    if (!sshReachableWithPubkey(target, spawnSync, env, identities)) {
      ok = false;
      row.ok = false;
      row.message = "SSH public-key auth failed";
      hosts.push(row);
      warn(`[${target.id}] mail relay: SSH public-key auth failed — skip.`);
      continue;
    }

    const exec = createConfigureExec("ssh", {
      user: target.user,
      host: target.host,
      env,
      log,
    });

    const result = await ensurePostfixSatellite({
      exec,
      log: plog,
      deployment: { system_id: target.id, hostname: target.id },
    });

    row.mail_relay = result;
    row.ok = result.skipped || result.ok;
    if (!row.ok) ok = false;
    hosts.push(row);
  }

  return { ok, hosts };
}
