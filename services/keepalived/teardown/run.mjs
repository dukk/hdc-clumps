#!/usr/bin/env node
/**
 * Teardown Keepalived QEMU director guests (never destroys real_server targets).
 *
 * Usage: hdc run service keepalived teardown -- [--instance a | --system-id vm-keepalived-a]
 *        hdc run service keepalived teardown -- [--dry-run] [--yes]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { stopAndDestroyQemu } from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { resolveKeepalivedDeployments } from "hdc/package/deployments.mjs";
import { locateGuest } from "hdc/package/proxmox-qemu-redeploy.mjs";
import { confirmTeardown, teardownDryRun } from "../../ollama/lib/teardown-confirm.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { keepalivedReportExtraSections } from "hdc/package/keepalived-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/keepalived/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolveKeepalivedDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function teardownOne(deployment, flags) {
  if (deployment.deploymentKind !== "director") {
    return {
      ok: false,
      system_id: deployment.systemId,
      message: "teardown only supports director deployments (real_server targets are never destroyed)",
    };
  }
  if (deployment.mode !== "proxmox-qemu") {
    return {
      ok: true,
      system_id: deployment.systemId,
      skipped: true,
      message: "configure-only director — no Proxmox guest to destroy",
    };
  }

  const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
  const dryRun = teardownDryRun(flags);
  const px = deployment.proxmox;
  if (!isObject(px)) {
    return { ok: false, system_id: deployment.systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: deployment.systemId, message: "missing host_id" };
  }
  const q = isObject(px.qemu) ? px.qemu : {};
  const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: deployment.systemId, host_id: hostId, message: "invalid vmid" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: locating ${JSON.stringify(deployment.systemId)} vmid ${vmid} (host ${JSON.stringify(hostId)}) …\n`,
  );
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await locateGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  if (!located) {
    return {
      ok: true,
      system_id: deployment.systemId,
      skipped: true,
      message: `vmid ${vmid} not found`,
    };
  }

  const detail = `QEMU vmid ${vmid} on ${located.node}`;
  if (dryRun) {
    errout.write(`[hdc] ${target} ${verb}: [dry-run] would destroy ${deployment.systemId}: ${detail}\n`);
    return { ok: true, system_id: deployment.systemId, dry_run: true, message: "dry-run" };
  }

  let proceed;
  try {
    proceed = await confirmTeardown(deployment.systemId, detail, flags);
  } catch (e) {
    return {
      ok: false,
      system_id: deployment.systemId,
      message: String(/** @type {Error} */ (e).message || e),
    };
  }
  if (!proceed) {
    return { ok: true, system_id: deployment.systemId, skipped: true, message: "cancelled" };
  }

  await stopAndDestroyQemu({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: located.node,
    vmid,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  return { ok: true, system_id: deployment.systemId, destroyed: true, vmid, node: located.node };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: keepalived teardown (stderr log; JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);

  let toTeardown;
  try {
    toTeardown = resolveKeepalivedDeployments(cfg, { ...flags, "director-only": "" });
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of toTeardown) {
    try {
      results.push(await teardownOne(deployment, flags));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok !== false);
  const payload = { ok, target, verb, results };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: logLine,
    extraSections: keepalivedReportExtraSections,
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
