#!/usr/bin/env node
/**
 * Teardown Minecraft Proxmox QEMU deployments.
 *
 * Usage: hdc run service minecraft teardown -- [--instance a | --system-id vm-minecraft-a]
 *        hdc run service minecraft teardown -- [--dry-run] [--yes]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { stopAndDestroyQemu } from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { resolveMinecraftDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "../../ollama/lib/guest-exists.mjs";
import { confirmTeardown, teardownDryRun } from "hdc/package/teardown-confirm.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import {
  loadClumpConfigFromClumpRoot,
  tryLoadClumpConfigFromClumpRoot,
} from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/minecraft/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: CLUMP_CONFIG_EXAMPLE,
    });
  }
  return _pkgConfig;
}

const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolveMinecraftDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function teardownOne(deployment, flags) {
  const { mode, systemId, proxmox: px } = deployment;
  const dryRun = teardownDryRun(flags);

  if (mode !== "proxmox-qemu") {
    return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  }

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const q = isObject(px.qemu) ? px.qemu : {};
  const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: locating ${JSON.stringify(systemId)} vmid ${vmid} (host ${JSON.stringify(hostId)}) …\n`,
  );
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
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      mode,
      message: String(/** @type {Error} */ (e).message || e),
    };
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
  try {
    await stopAndDestroyQemu({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: located.node,
      vmid,
      log: logLine,
    });
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
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
    message: `qemu ${vmid} destroyed`,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: tear down Minecraft deployments (stderr log; JSON on stdout).\n`);

  const cfgLoad = tryLoadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
  });
  if (!cfgLoad) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  _pkgConfig = cfgLoad;

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolveMinecraftDeployments(cfg, flags);
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

  provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await teardownOne(deployment, flags));
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
