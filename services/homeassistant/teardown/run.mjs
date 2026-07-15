#!/usr/bin/env node
/**
 * Teardown Home Assistant OS QEMU VM.
 *
 * Usage: hdc run service homeassistant teardown -- [--instance a] [--dry-run] [--yes]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { locateGuest, stopAndDestroyQemu } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { confirmTeardown, teardownDryRun } from "../../ollama/lib/teardown-confirm.mjs";
import { resolveHomeassistantDeployments } from "hdc/package/deployments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/homeassistant/config.example.json";
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

/**
 * @param {ReturnType<typeof resolveHomeassistantDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function teardownOne(deployment, flags) {
  const hostId = deployment.proxmox.hostId;
  const vmid = deployment.proxmox.qemu.vmid;
  const dryRun = teardownDryRun(flags);

  errout.write(
    `[hdc] ${target} ${verb}: ${deployment.systemId} vmid ${vmid} on ${hostId} …\n`,
  );

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await locateGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );

  if (!located) {
    errout.write(`[hdc] ${target} ${verb}: vmid ${vmid} not found — nothing to destroy.\n`);
    return { ok: true, system_id: deployment.systemId, skipped: true };
  }

  if (dryRun) {
    errout.write(
      `[hdc] ${target} ${verb}: dry-run — would destroy vmid ${vmid} (${located.name}) on ${located.node}.\n`,
    );
    return { ok: true, system_id: deployment.systemId, dry_run: true, vmid };
  }

  await confirmTeardown(deployment.systemId, vmid, flags);

  await stopAndDestroyQemu({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: located.node,
    vmid,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  return { ok: true, system_id: deployment.systemId, destroyed: true, vmid };
}

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  const cfg = ensurePackageConfig().data;

  errout.write(`[hdc] ${target} ${verb}: Home Assistant teardown.\n`);

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  try {
    const deployments = resolveHomeassistantDeployments(cfg, flags);
    for (const deployment of deployments) {
      try {
        const r = await teardownOne(deployment, flags);
        results.push(r);
      } catch (e) {
        ok = false;
        const msg = String(/** @type {Error} */ (e).message || e);
        errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
        results.push({ ok: false, system_id: deployment.systemId, message: msg });
      }
    }
  } catch (e) {
    ok = false;
    errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).message || e}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const payload = { ok, target, verb, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  process.exitCode = ok ? 0 : 1;
}

main();
