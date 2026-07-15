#!/usr/bin/env node
/**
 * Teardown Ollama deployments (Proxmox LXC/QEMU or Ubuntu Docker).
 *
 * Usage: hdc run service ollama teardown -- [--instance a | --system-id ollama-a]
 *        hdc run service ollama teardown -- [--dry-run] [--yes] [--remove-volume]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout, env } from "node:process";

import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import {
  stopAndDestroyLxc,
  stopAndDestroyQemu,
} from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { createUbuntuDockerHostProvisioner } from "../../../infrastructure/ubuntu/lib/ubuntu-docker-host-provisioner.mjs";
import { resolveUbuntuBootstrapSsh } from "../../../infrastructure/ubuntu/lib/ubuntu-ssh-resolve.mjs";
import { resolveOllamaDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import {
  confirmTeardown,
  teardownDryRun,
} from "hdc/package/teardown-confirm.mjs";

import { runOperationReportTail } from "hdc/package/operation-report.mjs";import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/ollama/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const root = repoRoot();

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolveOllamaDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
async function teardownOne(deployment, flags, log) {
  const { mode, systemId, proxmox: px, ubuntu: ub } = deployment;
  const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
  const ubuntuRoot = join(root, "clumps", "infrastructure", "ubuntu");
  const dryRun = teardownDryRun(flags);
  const removeVolume = flagGet(flags, "remove-volume", "remove_volume") !== undefined;

  if (!mode) {
    return { ok: false, system_id: systemId, message: "missing mode" };
  }

  if (mode === "ubuntu-docker") {
    if (!isObject(ub)) {
      return { ok: false, system_id: systemId, message: "bad ubuntu config" };
    }
    const bid = typeof ub.bootstrap_host_id === "string" ? ub.bootstrap_host_id.trim() : "";
    if (!bid) {
      return { ok: false, system_id: systemId, message: "missing bootstrap_host_id" };
    }
    const dk = isObject(ub.docker) ? ub.docker : {};
    const containerName =
      typeof dk.container_name === "string" && dk.container_name.trim()
        ? dk.container_name.trim()
        : "ollama";
    const detail = `docker container ${containerName} on ${bid}`;

    if (dryRun) {
      errout.write(`[hdc] ${target} ${verb}: [dry-run] would destroy ${systemId}: ${detail}\n`);
      return { ok: true, system_id: systemId, mode, dry_run: true, message: "dry-run" };
    }

    let proceed;
    try {
      proceed = await confirmTeardown(systemId, detail, flags);
    } catch (e) {
      return { ok: false, system_id: systemId, mode, message: String(/** @type {Error} */ (e).message || e) };
    }
    if (!proceed) {
      errout.write(`[hdc] ${target} ${verb}: cancelled ${systemId}.\n`);
      return { ok: true, system_id: systemId, mode, skipped: true, message: "cancelled" };
    }

    errout.write(`[hdc] ${target} ${verb}: ${systemId} ubuntu-docker on ${JSON.stringify(bid)} …\n`);
    const ssh = resolveUbuntuBootstrapSsh(ubuntuRoot, bid, env);
    if (!ssh) {
      return { ok: false, system_id: systemId, message: "ssh not resolved" };
    }
    const prov = createUbuntuDockerHostProvisioner({ sshUser: ssh.user, sshHost: ssh.host });
    const result = await prov.destroyContainer(
      log,
      {
        name: containerName,
        parameters: { ...dk },
      },
      { removeVolume },
    );
    return {
      ok: result.ok,
      system_id: systemId,
      mode,
      host_id: bid,
      destroyed: result.ok && !result.details?.skipped,
      skipped: Boolean(result.details?.skipped),
      result,
    };
  }

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const guestKind = mode === "proxmox-lxc" ? "lxc" : mode === "proxmox-qemu" ? "qemu" : null;
  if (!guestKind) {
    return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  }

  const guestCfg = guestKind === "lxc" ? (isObject(px.lxc) ? px.lxc : {}) : isObject(px.qemu) ? px.qemu : {};
  const vmid = typeof guestCfg.vmid === "number" ? guestCfg.vmid : Number(guestCfg.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: locating ${JSON.stringify(systemId)} vmid ${vmid} (host ${JSON.stringify(hostId)}) …\n`,
  );
  errout.write(`[hdc] ${target} ${verb}: authorizing Proxmox API for host ${JSON.stringify(hostId)} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });

  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );

  if (!located) {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} not in cluster — nothing to destroy.\n`);
    return {
      ok: true,
      system_id: systemId,
      host_id: hostId,
      mode,
      skipped: true,
      message: "guest not found",
      vmid,
    };
  }

  const guestName = located.name ? String(located.name) : "";
  const detail = `vmid ${vmid} on ${located.node}${guestName ? ` (${guestName})` : ""}`;

  if (dryRun) {
    errout.write(`[hdc] ${target} ${verb}: [dry-run] would destroy ${systemId}: ${detail}\n`);
    return {
      ok: true,
      system_id: systemId,
      host_id: hostId,
      mode,
      dry_run: true,
      vmid,
      node: located.node,
      message: "dry-run",
    };
  }

  let proceed;
  try {
    proceed = await confirmTeardown(systemId, detail, flags);
  } catch (e) {
    return { ok: false, system_id: systemId, host_id: hostId, mode, message: String(/** @type {Error} */ (e).message || e) };
  }
  if (!proceed) {
    errout.write(`[hdc] ${target} ${verb}: cancelled ${systemId}.\n`);
    return {
      ok: true,
      system_id: systemId,
      host_id: hostId,
      mode,
      skipped: true,
      message: "cancelled",
      vmid,
      node: located.node,
    };
  }

  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`);
  const destroyOpts = {
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: located.node,
    vmid,
    log: logLine,
  };

  try {
    if (guestKind === "lxc") {
      await stopAndDestroyLxc(destroyOpts);
    } else {
      await stopAndDestroyQemu(destroyOpts);
    }
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${systemId} destroy failed: ${msg}\n`);
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      mode,
      vmid,
      node: located.node,
      message: msg,
    };
  }

  return {
    ok: true,
    system_id: systemId,
    host_id: hostId,
    mode,
    destroyed: true,
    vmid,
    node: located.node,
    message: `${guestKind} ${vmid} destroyed`,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: tear down Ollama deployments (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  /** @type {ReturnType<typeof resolveOllamaDeployments>} */
  let deployments;
  try {
    deployments = resolveOllamaDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (deployments.length > 1) {
    errout.write(`[hdc] ${target} ${verb}: tearing down ${deployments.length} instance(s) …\n`);
  }

  const log = provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await teardownOne(deployment, flags, log));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok);
  const payload = { ok, target, verb, count: results.length, results };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
