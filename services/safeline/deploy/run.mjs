#!/usr/bin/env node
/**
 * Deploy SafeLine WAF on Proxmox LXC (Docker Compose).
 *
 * Usage: hdc run service safeline deploy -- [--instance a | --system-id safeline-a] [--skip-install]
 *        hdc run service safeline deploy -- [--skip-existing | --redeploy-existing] [--skip-sites] [--skip-admin-reset]
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

import { resolveSafelineDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import {
  installSafelineInCt,
  readCtPrimaryIp,
  resolvePveSshForHost,
} from "hdc/package/safeline-install.mjs";
import { syncSafelineSites } from "hdc/package/safeline-sites-run.mjs";
import { resolveWebUrl } from "hdc/package/safeline-render.mjs";
import {
  ensureLxcDockerApparmorWorkaround,
  pctRestart,
  pctSetFeatures,
} from "hdc/package/pve-pct-remote.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { createSafelineVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolveApiToken, resolvePostgresPassword } from "hdc/package/vault-secrets.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/safeline/config.example.json";
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
 * @param {ReturnType<typeof resolveSafelineDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null }; postgresPassword: string; apiToken: string | null; vault: ReturnType<typeof createSafelineVaultAccess> }} runOpts
 */
async function deployOne(deployment, flags, log, runOpts) {
  const { mode, systemId, proxmox: px, safeline, install, sites } = deployment;
  const skipSites = flagGet(flags, "skip-sites", "skip_sites") !== undefined;
  const skipAdminReset = flagGet(flags, "skip-admin-reset", "skip_admin_reset") !== undefined;

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
  /** @type {Record<string, unknown> | null} */
  let installResult = null;
  /** @type {Record<string, unknown> | null} */
  let sitesResult = null;

  if (!skipProvision) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,    });
    const hostname =
      (typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
      lxcHostnameFromSystemId(systemId) ||
      "safeline";
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
    const parameters = { ...lxc, password: rootPassword };
    provisionResult = await prov.createContainer(log, {
      name: hostname,
      memoryMb,
      cores,
      diskGb,
      parameters,
    });
    if (!provisionResult.ok) {
      return { ok: false, system_id: systemId, host_id: hostId, mode, result: provisionResult };
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
  const unprivileged = lxc.unprivileged === undefined ? 1 : Number(lxc.unprivileged) === 0 ? 0 : 1;
  const lxcFeatures = typeof lxc.features === "string" ? lxc.features.trim() : "";
  if (unprivileged === 0 && lxcFeatures) {
    const fr = pctSetFeatures(pveSsh.user, pveSsh.host, guestVmid, lxcFeatures, { capture: true });
    if (fr.status !== 0) {
      const msg = `pct set -features failed (exit ${fr.status}): ${(fr.stderr || fr.stdout).trim()}`;
      return { ok: false, system_id: systemId, host_id: hostId, mode, result: provisionResult, message: msg };
    }
  }
  if (unprivileged === 0) {
    const ar = ensureLxcDockerApparmorWorkaround(pveSsh.user, pveSsh.host, guestVmid, { capture: true });
    if (ar.status !== 0) {
      const msg = `LXC AppArmor workaround failed (exit ${ar.status}): ${(ar.stderr || ar.stdout).trim()}`;
      return { ok: false, system_id: systemId, host_id: hostId, mode, result: provisionResult, message: msg };
    }
    if (/changed=1/.test(ar.stdout)) {
      const rr = pctRestart(pveSsh.user, pveSsh.host, guestVmid, { capture: true });
      if (rr.status !== 0) {
        return {
          ok: false,
          system_id: systemId,
          host_id: hostId,
          mode,
          result: provisionResult,
          message: `pct restart failed (exit ${rr.status})`,
        };
      }
    }
  }

  const safelineCfg = isObject(safeline) ? safeline : {};
  const installCfg = isObject(install) ? install : {};

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
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
        message: String(/** @type {Error} */ (e).message || e),
      };
    }
    const adminReset =
      !skipAdminReset && safelineCfg.admin_reset_on_deploy !== false;
    installResult = await installSafelineInCt(
      pveSsh.user,
      pveSsh.host,
      guestVmid,
      safelineCfg,
      installCfg,
      runOpts.postgresPassword,
      { adminReset, vault: runOpts.vault },
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

  if (!skipSites && sites.length > 0) {
    if (!runOpts.apiToken) {
      errout.write(
        `[hdc] ${target} ${verb}: sites[] configured but API token missing — skip site sync (set vault token or use --skip-sites).\n`,
      );
      sitesResult = { ok: true, skipped: true, reason: "api_token_missing" };
    } else {
      try {
        sitesResult = await syncSafelineSites(
          pveSsh.user,
          pveSsh.host,
          guestVmid,
          safelineCfg,
          sites,
          runOpts.apiToken,
          { prune: false },
        );
        if (!sitesResult.ok) {
          return {
            ok: false,
            system_id: systemId,
            host_id: hostId,
            mode,
            ip,
            result: provisionResult,
            install: installResult,
            sites: sitesResult,
            message: "site sync failed",
          };
        }
      } catch (e) {
        return {
          ok: false,
          system_id: systemId,
          host_id: hostId,
          message: String(/** @type {Error} */ (e).message || e),
        };
      }
    }
  }

  return {
    ok: true,
    system_id: systemId,
    host_id: hostId,
    mode,
    redeploy: skipProvision,
    ip,
    url: resolveWebUrl(ip, safelineCfg),
    mgt_url: installResult.mgt_url ?? resolveWebUrl(ip, safelineCfg),
    result: provisionResult,
    install: installResult,
    sites: sitesResult,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: SafeLine WAF LXC via Proxmox (stderr log; JSON on stdout).\n`);

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
  let deployments;
  try {
    deployments = resolveSafelineDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createSafelineVaultAccess();
  const firstSafeline = isObject(deployments[0]?.safeline) ? deployments[0].safeline : {};
  const { password: postgresPassword } = await resolvePostgresPassword(vault, firstSafeline);
  const { token: apiToken } = await resolveApiToken(vault, firstSafeline);

  const log = provisionLogFromConsole(console);
  const ctPasswordCache = { value: null };
  const results = [];
  for (const deployment of deployments) {
    try {
      const safelineCfg = isObject(deployment.safeline) ? deployment.safeline : {};
      const { password } = await resolvePostgresPassword(vault, safelineCfg);
      const { token } = await resolveApiToken(vault, safelineCfg);
      results.push(
        await deployOne(deployment, flags, log, {
          ctPasswordCache,
          postgresPassword: password || postgresPassword,
          apiToken: token || apiToken,
          vault,
        }),
      );
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
