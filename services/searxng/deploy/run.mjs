#!/usr/bin/env node
/**
 * Deploy SearXNG on Proxmox LXC (Docker Compose).
 *
 * Usage: hdc run service searxng deploy -- [--instance a | --system-id searxng-a] [--skip-install]
 *        hdc run service searxng deploy -- [--skip-existing | --redeploy-existing]
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

import { hostPort, resolveSearxngDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { installSearxngInCt, readCtPrimaryIp, resolvePveSshForHost } from "hdc/package/searxng-install.mjs";
import {
  ensureLxcDockerApparmorWorkaround,
  pctRestart,
  pctSetFeatures,
} from "hdc/package/pve-pct-remote.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { createSearxngVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolveSearxngSecret } from "hdc/package/vault-secrets.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/searxng/config.example.json";
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
 * @param {Record<string, unknown>} install
 */
function shouldInstall(install) {
  return install.enabled !== false;
}

/**
 * @param {Record<string, string>} flags
 */
function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  return "prompt";
}

/**
 * @param {ReturnType<typeof resolveSearxngDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null }; secret: string }} runOpts
 */
async function deployOne(deployment, flags, log, runOpts) {
  const { mode, systemId, proxmox: px, searxng, install } = deployment;

  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (mode !== "proxmox-lxc") {
    return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  }

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: ${JSON.stringify(systemId)} on ${JSON.stringify(hostId)} mode ${JSON.stringify(mode)} …\n`,
  );
  errout.write(`[hdc] ${target} ${verb}: authorizing Proxmox API for host ${JSON.stringify(hostId)} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });

  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );

  let skipProvision = false;
  if (located) {
    const policy = existingGuestPolicy(flags);
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    }
    if (action === "skip") {
      errout.write(`[hdc] ${target} ${verb}: skipping ${systemId} (vmid ${vmid} already exists).\n`);
      return {
        ok: true,
        system_id: systemId,
        host_id: hostId,
        mode,
        skipped: true,
        message: "guest already exists",
        guest: { vmid, node: located.node, name: located.name },
      };
    }
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} exists — redeploy (provision skipped, install only).\n`,
    );
    skipProvision = true;
  }

  /** @type {import("../../../lib/host-provisioner.mjs").ProvisionResult | null} */
  let provisionResult = null;
  /** @type {{ ok: boolean; method?: string; message?: string; public_url?: string | null } | null} */
  let installResult = null;

  if (!skipProvision) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,    });
    const hostname =
      (typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
      lxcHostnameFromSystemId(systemId) ||
      "searxng";
    const memoryMb = typeof lxc.memory_mb === "number" ? lxc.memory_mb : Number(lxc.memory_mb);
    const cores = typeof lxc.cores === "number" ? lxc.cores : Number(lxc.cores);
    const diskGb = typeof lxc.rootfs_gb === "number" ? lxc.rootfs_gb : Number(lxc.rootfs_gb);
    if (![memoryMb, cores, diskGb].every((n) => Number.isFinite(n) && n > 0)) {
      return { ok: false, system_id: systemId, host_id: hostId, message: "invalid lxc sizing fields" };
    }
    const cache = runOpts.ctPasswordCache ?? { value: null };
    let rootPassword;
    try {
      rootPassword = await resolveLxcRootPassword(systemId, vmid, lxc, flags, {
        cached: cache.value,
        setCached: (v) => {
          cache.value = v;
        },
      });
    } catch (e) {
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        message: String(/** @type {Error} */ (e).message || e),
      };
    }
    /** @type {Record<string, unknown>} */
    const parameters = { ...lxc, password: rootPassword };
    provisionResult = await prov.createContainer(log, {
      name: hostname,
      memoryMb,
      cores,
      diskGb,
      parameters,
    });
    if (!provisionResult.ok) {
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
      };
    }
  } else {
    provisionResult = {
      ok: true,
      message: `LXC ${vmid} already present on ${located?.node ?? "?"}`,
      details: { vmid, node: located?.node, type: "lxc", skipped_provision: true },
    };
  }

  const guestVmid = resolveProvisionVmid(provisionResult, vmid);

  const lxcNode =
    (typeof provisionResult.details?.node === "string" && provisionResult.details.node.trim()) ||
    located?.node ||
    auth.host.pveNode;

  await waitForLxcCreateTaskAndApplyResources(
    provisionResult,
    auth,
    vmid,
    (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    guestResourceOptsFromBlock(lxc, flags),
  );

  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const unprivileged =
    lxc.unprivileged === undefined ? 1 : Number(lxc.unprivileged) === 0 ? 0 : 1;
  const lxcFeatures = typeof lxc.features === "string" ? lxc.features.trim() : "";
  if (unprivileged === 0 && lxcFeatures) {
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId}: applying LXC features via pct on ${pveSsh.host} …\n`,
    );
    const fr = pctSetFeatures(pveSsh.user, pveSsh.host, guestVmid, lxcFeatures, { capture: true });
    if (fr.status !== 0) {
      const msg = `pct set -features failed (exit ${fr.status}): ${(fr.stderr || fr.stdout).trim()}`;
      errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${msg}\n`);
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
        message: msg,
      };
    }
  }

  if (unprivileged === 0) {
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId}: ensuring Docker AppArmor workaround on ${pveSsh.host} …\n`,
    );
    const ar = ensureLxcDockerApparmorWorkaround(pveSsh.user, pveSsh.host, guestVmid, {
      capture: true,
    });
    if (ar.status !== 0) {
      const msg = `LXC AppArmor workaround failed (exit ${ar.status}): ${(ar.stderr || ar.stdout).trim()}`;
      errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${msg}\n`);
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
        message: msg,
      };
    }
    if (/changed=1/.test(ar.stdout)) {
      errout.write(
        `[hdc] ${target} ${verb}: ${systemId}: restarting CT ${guestVmid} to apply LXC config …\n`,
      );
      const rr = pctRestart(pveSsh.user, pveSsh.host, guestVmid, { capture: true });
      if (rr.status !== 0) {
        const msg = `pct restart failed (exit ${rr.status}): ${(rr.stderr || rr.stdout).trim()}`;
        return {
          ok: false,
          system_id: systemId,
          host_id: hostId,
          mode,
          result: provisionResult,
          message: msg,
        };
      }
    }
  }

  if (shouldInstall(install)) {
    try {
      await ensureLxcStarted({
        apiBase: auth.host.apiBase,
        node: lxcNode,
        vmid: guestVmid,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
        message: msg,
      };
    }
  }

  const searxngCfg = isObject(searxng) ? searxng : {};
  const installCfg = isObject(install) ? install : {};

  if (shouldInstall(install)) {
    installResult = await installSearxngInCt(
      pveSsh.user,
      pveSsh.host,
      guestVmid,
      searxngCfg,
      installCfg,
      runOpts.secret,
    );
  } else {
    installResult = { ok: true, method: "skipped", message: "skipped" };
    errout.write(`[hdc] ${target} ${verb}: install skipped for ${systemId}.\n`);
  }

  if (!installResult.ok) {
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      mode,
      redeploy: skipProvision,
      result: provisionResult,
      install: installResult,
    };
  }

  const ip = readCtPrimaryIp(pveSsh.user, pveSsh.host, guestVmid);
  const port = hostPort(searxngCfg);
  const uiUrl = ip ? `http://${ip}:${port}` : installResult.public_url ?? null;

  return {
    ok: provisionResult.ok && installResult.ok,
    system_id: systemId,
    host_id: hostId,
    mode,
    redeploy: skipProvision,
    ip,
    ui_url: uiUrl,
    result: provisionResult,
    install: installResult,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: SearXNG LXC via Proxmox (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    const inv = deployTargetInventory(root, target);
    logDeployInventoryStatus(target, verb, inv);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));

  /** @type {ReturnType<typeof resolveSearxngDeployments>} */
  let deployments;
  try {
    deployments = resolveSearxngDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createSearxngVaultAccess();
  const defaultsSearxng =
    isObject(cfg.defaults) && isObject(cfg.defaults.searxng) ? cfg.defaults.searxng : {};
  const { secret, vaultKey } = await resolveSearxngSecret(vault, defaultsSearxng);
  errout.write(`[hdc] ${target} ${verb}: secret ready (vault ${vaultKey})\n`);

  const log = provisionLogFromConsole(console);
  /** @type {{ value: string | null }} */
  const ctPasswordCache = { value: null };
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await deployOne(deployment, flags, log, { ctPasswordCache, secret }));
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
