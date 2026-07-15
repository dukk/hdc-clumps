#!/usr/bin/env node
/**
 * Deploy Trivy on Proxmox LXC.
 *
 * Usage: hdc run service trivy deploy -- [--instance a | --system-id trivy-a] [--skip-install]
 *        hdc run service trivy deploy -- [--skip-existing | --redeploy-existing]
 */
import { lxcHostnameFromSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForLxcCreateTaskAndApplyResources } from "../../../infrastructure/proxmox/lib/proxmox-lxc-post-create.mjs";
import { ensureLxcStarted } from "../../../infrastructure/proxmox/lib/proxmox-lxc-start.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { resolveProvisionVmid } from "../../../infrastructure/proxmox/lib/proxmox-vmid-conflict.mjs";

import { resolveTrivyDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { installTrivyInCt, readCtPrimaryIp, resolvePveSshForHost } from "hdc/package/trivy-install.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/trivy/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let pkgConfig = null;
function ensurePackageConfig() {
  if (!pkgConfig) pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  return pkgConfig;
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
/** @param {Record<string, unknown>} install */
function shouldInstall(install) {
  return install.enabled !== false;
}
/** @param {Record<string, string>} flags */
function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  return "prompt";
}

/**
 * @param {ReturnType<typeof resolveTrivyDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null } }} runOpts
 */
async function deployOne(deployment, flags, log, runOpts) {
  const { mode, systemId, proxmox: px, trivy, install } = deployment;
  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);
  if (mode !== "proxmox-lxc") return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  if (!isObject(px)) return { ok: false, system_id: systemId, message: "bad proxmox config" };
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return { ok: false, system_id: systemId, message: "missing host_id" };
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  const located = await findClusterGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  let skipProvision = false;
  if (located) {
    let action = existingGuestPolicy(flags);
    if (action === "prompt") action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    if (action === "skip") return { ok: true, system_id: systemId, host_id: hostId, mode, skipped: true, message: "guest already exists" };
    skipProvision = true;
  }

  /** @type {import("../../../lib/host-provisioner.mjs").ProvisionResult | null} */
  let provisionResult = null;
  if (!skipProvision) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,    });
    const hostname = (typeof lxc.hostname === "string" && lxc.hostname.trim()) || lxcHostnameFromSystemId(systemId) || "trivy";
    const memoryMb = typeof lxc.memory_mb === "number" ? lxc.memory_mb : Number(lxc.memory_mb);
    const cores = typeof lxc.cores === "number" ? lxc.cores : Number(lxc.cores);
    const diskGb = typeof lxc.rootfs_gb === "number" ? lxc.rootfs_gb : Number(lxc.rootfs_gb);
    if (![memoryMb, cores, diskGb].every((n) => Number.isFinite(n) && n > 0)) return { ok: false, system_id: systemId, host_id: hostId, message: "invalid lxc sizing fields" };
    const cache = runOpts.ctPasswordCache ?? { value: null };
    let rootPassword;
    try {
      rootPassword = await resolveLxcRootPassword(systemId, vmid, lxc, flags, { cached: cache.value, setCached: (v) => (cache.value = v) });
    } catch (e) {
      return { ok: false, system_id: systemId, host_id: hostId, message: String(/** @type {Error} */ (e).message || e) };
    }
    provisionResult = await prov.createContainer(log, { name: hostname, memoryMb, cores, diskGb, parameters: { ...lxc, password: rootPassword } });
    if (!provisionResult.ok) return { ok: false, system_id: systemId, host_id: hostId, mode, result: provisionResult };
  } else {
    provisionResult = { ok: true, message: `LXC ${vmid} already present`, details: { vmid, node: located?.node, type: "lxc", skipped_provision: true } };
  }

  const guestVmid = resolveProvisionVmid(provisionResult, vmid);
  const lxcNode = (typeof provisionResult.details?.node === "string" && provisionResult.details.node.trim()) || located?.node || auth.host.pveNode;
  await waitForLxcCreateTaskAndApplyResources(provisionResult, auth, vmid, (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`), guestResourceOptsFromBlock(lxc, flags));
  if (shouldInstall(install)) {
    await ensureLxcStarted({
      apiBase: auth.host.apiBase,
      node: lxcNode,
      vmid: guestVmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    });
  }
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const trivyCfg = isObject(trivy) ? trivy : {};
  const installResult = shouldInstall(install)
    ? await installTrivyInCt(pveSsh.user, pveSsh.host, guestVmid, trivyCfg)
    : { ok: true, method: "skipped", message: "skipped" };
  if (!installResult.ok) return { ok: false, system_id: systemId, host_id: hostId, mode, result: provisionResult, install: installResult };
  const ip = readCtPrimaryIp(pveSsh.user, pveSsh.host, guestVmid);
  return { ok: true, system_id: systemId, host_id: hostId, mode, redeploy: skipProvision, ip, result: provisionResult, install: installResult };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Trivy LXC via Proxmox (stderr log; JSON on stdout).\n`);
  if (!existsSync(ensurePackageConfig().path)) {
    const inv = deployTargetInventory(root, target);
    logDeployInventoryStatus(target, verb, inv);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: "clump config missing - see stderr" }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolveTrivyDeployments(cfg, flags);
  } catch (e) {
    const message = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const log = provisionLogFromConsole(console);
  const ctPasswordCache = { value: null };
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await deployOne(deployment, flags, log, { ctPasswordCache }));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
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
