#!/usr/bin/env node
/**
 * Destroy the FreePBX QEMU guest. Does not remove the Debian template.
 *
 * Usage: hdc run service freepbx teardown -- [--instance a] [--dry-run] [--yes]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { fetchClusterVmResources } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { stopAndDestroyQemu } from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { locateGuestByName } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import {
  mergedProxmoxBlock,
  normalizeFreepbxConfig,
  resolveFreepbxDeployments,
} from "hdc/package/deployments.mjs";
import { confirmTeardown, teardownDryRun } from "../../ollama/lib/teardown-confirm.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/freepbx/config.example.json";
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

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: destroy FreePBX QEMU guest.\n`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const cfg = ensurePackageConfig().data;
  const norm = normalizeFreepbxConfig(cfg);
  const deployments = resolveFreepbxDeployments(cfg, flags);
  const dryRun = teardownDryRun(flags);
  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let allOk = true;

  for (const d of deployments) {
    const px = mergedProxmoxBlock(norm.defaults, d.proxmox);
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    const q = isObject(px.qemu) ? px.qemu : {};
    const guestName = d.hostname || d.systemId.replace(/^vm-/, "");
    let vmid = Number(q.vmid);
    let node = "";
    if (!hostId) {
      results.push({ ok: false, system_id: d.systemId, message: "missing host_id" });
      allOk = false;
      continue;
    }
    const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
    const resources = await fetchClusterVmResources(
      auth.host.apiBase,
      auth.authorization,
      auth.rejectUnauthorized,
    );
    const byName = locateGuestByName(resources, guestName);
    if (byName) {
      vmid = byName.vmid;
      node = byName.node;
    }
    if (!Number.isFinite(vmid) || vmid <= 0 || !node) {
      results.push({ ok: false, system_id: d.systemId, message: `guest ${guestName} not found` });
      allOk = false;
      continue;
    }
    if (dryRun) {
      logLine(`dry-run: would destroy ${guestName} vmid ${vmid} on ${node}`);
      results.push({ ok: true, system_id: d.systemId, dry_run: true, vmid, node });
      continue;
    }
    const confirmed = await confirmTeardown(d.systemId, `${guestName} vmid ${vmid} on ${node}`, flags);
    if (!confirmed) {
      results.push({ ok: false, system_id: d.systemId, message: "teardown not confirmed" });
      allOk = false;
      continue;
    }
    await stopAndDestroyQemu({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node,
      vmid,
      log: logLine,
    });
    results.push({ ok: true, system_id: d.systemId, vmid, node, destroyed: true });
  }

  const payload = { ok: allOk, target, verb, count: results.length, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok: allOk,
    log: logLine,
  });
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).message || e}\n`);
  process.exitCode = 1;
});
