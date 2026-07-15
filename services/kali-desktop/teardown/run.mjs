#!/usr/bin/env node
/**
 * Teardown Kali desktop QEMU guests.
 *
 * Usage: hdc run service kali-desktop teardown -- [--instance a] [--dry-run] [--yes]
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
  normalizeKaliDesktopConfig,
  resolveKaliDesktopDeployments,
} from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { confirmTeardown, teardownDryRun } from "../../ollama/lib/teardown-confirm.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/kali-desktop/config.example.json";
const root = repoRoot();

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

/**
 * @param {ReturnType<typeof resolveKaliDesktopDeployments>[number]} deployment
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, string>} flags
 */
async function teardownOne(deployment, defaults, flags) {
  const { systemId, proxmox: pxRaw, hostname: cfgHostname } = deployment;
  const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
  const dryRun = teardownDryRun(flags);

  const px = mergedProxmoxBlock(defaults, pxRaw);
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const q = isObject(px.qemu) ? px.qemu : {};
  const guestName =
    cfgHostname ||
    systemId.replace(/^vm-/, "").slice(0, 63);
  let vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);

  if (!Number.isFinite(vmid) || vmid <= 0) {
    const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
    const resources = await fetchClusterVmResources(
      auth.host.apiBase,
      auth.authorization,
      auth.rejectUnauthorized,
    );
    const byName = locateGuestByName(resources, guestName);
    if (!byName) {
      return { ok: false, system_id: systemId, message: `guest ${guestName} not found` };
    }
    vmid = byName.vmid;
  }

  const detail = `QEMU vmid ${vmid} on ${hostId}`;
  if (dryRun) {
    errout.write(`[hdc] ${target} ${verb}: [dry-run] would destroy ${systemId}: ${detail}\n`);
    return { ok: true, system_id: systemId, dry_run: true, vmid };
  }

  let proceed;
  try {
    proceed = await confirmTeardown(systemId, detail, flags);
  } catch (e) {
    return { ok: false, system_id: systemId, message: String(/** @type {Error} */ (e).message || e) };
  }
  if (!proceed) {
    return { ok: true, system_id: systemId, cancelled: true, vmid };
  }

  errout.write(`[hdc] ${target} ${verb}: authorizing Proxmox for ${hostId} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );
  if (!located) {
    return { ok: true, system_id: systemId, vmid, message: "guest not found (already removed)" };
  }

  await stopAndDestroyQemu({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: located.node,
    vmid,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  return { ok: true, system_id: systemId, vmid, destroyed: true, node: located.node };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: destroy Kali desktop QEMU guests.\n`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const cfg = ensurePackageConfig().data;
  const { defaults } = normalizeKaliDesktopConfig(cfg);
  const deployments = resolveKaliDesktopDeployments(cfg, flags);

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let allOk = true;
  for (const d of deployments) {
    try {
      const r = await teardownOne(d, defaults, flags);
      results.push(r);
      if (!r.ok) allOk = false;
    } catch (e) {
      allOk = false;
      results.push({ ok: false, system_id: d.systemId, message: String(/** @type {Error} */ (e).message || e) });
    }
  }

  const payload = { ok: allOk, target, verb, deployments: results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  await runOperationReportTail({
    target,
    verb,
    clumpRoot,
    payload,
    flags,
    log: (line) => errout.write(`${line}\n`),
  });
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${e.message || e}\n`);
  process.exitCode = 1;
});
