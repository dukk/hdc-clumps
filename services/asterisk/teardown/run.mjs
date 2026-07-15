#!/usr/bin/env node
/**
 * Teardown Asterisk Proxmox deployments (LXC or QEMU).
 *
 * Usage: hdc run service asterisk teardown -- [--instance a | --system-id asterisk-a]
 *        [--dry-run] [--yes]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { stopAndDestroyLxc } from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { stopAndDestroyQemu } from "../../step-ca/lib/proxmox-qemu-redeploy.mjs";
import { resolveAsteriskDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { confirmTeardown, teardownDryRun } from "../../ollama/lib/teardown-confirm.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/asterisk/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
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
 * @param {ReturnType<typeof resolveAsteriskDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function teardownOne(deployment, flags) {
  const { mode, systemId, proxmox: px } = deployment;
  const dryRun = teardownDryRun(flags);

  if (mode === "configure-only") {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} configure-only — nothing to destroy.\n`);
    return { ok: true, system_id: systemId, skipped: true, message: "configure-only" };
  }

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const lxc = isObject(px.lxc) ? px.lxc : {};
  const qemu = isObject(px.qemu) ? px.qemu : {};
  const vmid =
    mode === "proxmox-qemu"
      ? typeof qemu.vmid === "number"
        ? qemu.vmid
        : Number(qemu.vmid)
      : typeof lxc.vmid === "number"
        ? lxc.vmid
        : Number(lxc.vmid);

  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, message: "invalid vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} on ${hostId} …\n`);

  if (!dryRun && flagGet(flags, "yes") === undefined) {
    const confirmed = await confirmTeardown(systemId, vmid);
    if (!confirmed) {
      return { ok: false, system_id: systemId, cancelled: true, message: "not confirmed" };
    }
  }

  if (dryRun) {
    return { ok: true, system_id: systemId, dry_run: true, vmid, host_id: hostId, mode };
  }

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );
  if (!located) {
    return { ok: true, system_id: systemId, message: "guest not found", vmid };
  }

  if (mode === "proxmox-qemu") {
    await stopAndDestroyQemu({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: located.node,
      vmid,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
  } else {
    await stopAndDestroyLxc({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: located.node,
      vmid,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
  }

  return { ok: true, system_id: systemId, destroyed: true, vmid, node: located.node, mode };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Asterisk teardown (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolveAsteriskDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await teardownOne(deployment, flags));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok !== false);
  const payload = { ok, target, verb, count: results.length, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
