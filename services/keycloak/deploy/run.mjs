#!/usr/bin/env node
/**
 * Deploy Keycloak on Proxmox LXC (Docker Compose).
 *
 * Usage: hdc run service keycloak deploy -- [--instance a | --system-id keycloak-a] [--skip-install]
 *        hdc run service keycloak deploy -- [--skip-existing | --redeploy-existing]
 *        [--skip-realms] [--skip-identity-providers] [--prune] [--realm <id>] [--dry-run]
 *        [--rotate-user-passwords] [--rotate-client-secrets] [--rotate-idp-secrets]
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

import { databasePasswordVaultKey, resolveKeycloakDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { installKeycloakInCt, readCtPrimaryIp, resolvePveSshForHost } from "hdc/package/keycloak-install.mjs";
import { reconcileKeycloakRealmsForConfig } from "hdc/package/keycloak-realms.mjs";
import { adminPasswordVaultKey, databaseConfig, hostPort, normalizeExternalUrl } from "hdc/package/keycloak-render.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { createKeycloakVaultAccess } from "hdc/package/vault-deps.mjs";
import {
  ensureLxcDockerApparmorWorkaround,
  pctRestart,
  pctSetFeatures,
} from "hdc/package/pve-pct-remote.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/keycloak/config.example.json";
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
 * @param {ReturnType<typeof resolveKeycloakDeployments>[number]} deployment
 * @param {ReturnType<typeof createKeycloakVaultAccess>} vault
 */
async function loadSecrets(deployment, vault) {
  const keycloak = isObject(deployment.keycloak) ? deployment.keycloak : {};
  const adminKey = adminPasswordVaultKey(keycloak);
  const dbKey = databasePasswordVaultKey(keycloak);
  errout.write(`[hdc] ${target} ${verb}: loading vault ${adminKey} …\n`);
  const adminPassword = String(await vault.getSecret(adminKey, { promptLabel: `vault secret ${adminKey}` })).trim();
  if (!adminPassword) throw new Error(`missing vault ${adminKey}`);
  errout.write(`[hdc] ${target} ${verb}: loading vault ${dbKey} …\n`);
  const dbPassword = String(await vault.getSecret(dbKey, { promptLabel: `vault secret ${dbKey}` })).trim();
  if (!dbPassword) throw new Error(`missing vault ${dbKey}`);
  return { adminPassword, dbPassword, adminKey, dbKey };
}

/**
 * @param {ReturnType<typeof resolveKeycloakDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null }; vault: ReturnType<typeof createKeycloakVaultAccess> }} runOpts
 */
async function deployOne(deployment, flags, log, runOpts) {
  const { mode, systemId, proxmox: px, keycloak, install } = deployment;
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
  /** @type {{ ok: boolean; method?: string; message?: string } | null} */
  let installResult = null;

  if (!skipProvision) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
    });
    const hostname =
      (typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
      lxcHostnameFromSystemId(systemId) ||
      "keycloak";
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

  const keycloakCfg = isObject(keycloak) ? keycloak : {};
  /** @type {{ adminPassword: string; dbPassword: string; adminKey: string; dbKey: string } | null} */
  let secrets = null;
  if (shouldInstall(install)) {
    secrets = await loadSecrets(deployment, runOpts.vault);
    installResult = await installKeycloakInCt(
      pveSsh.user,
      pveSsh.host,
      guestVmid,
      keycloakCfg,
      isObject(install) ? install : {},
      { adminPassword: secrets.adminPassword, dbPassword: secrets.dbPassword },
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
  const skipRealms = flagGet(flags, "skip-realms", "skip_realms") !== undefined;
  const skipIdentityProviders =
    flagGet(flags, "skip-identity-providers", "skip_identity_providers") !== undefined;
  const prune = flagGet(flags, "prune") !== undefined;
  const dryRun = flagGet(flags, "dry-run", "dry_run") !== undefined;
  const rotateUserPasswords =
    flagGet(flags, "rotate-user-passwords", "rotate_user_passwords") !== undefined;
  const rotateClientSecrets =
    flagGet(flags, "rotate-client-secrets", "rotate_client_secrets") !== undefined;
  const rotateIdpSecrets =
    flagGet(flags, "rotate-idp-secrets", "rotate_idp_secrets") !== undefined;
  const realmFilterRaw = flagGet(flags, "realm");
  const realmFilter =
    typeof realmFilterRaw === "string" && realmFilterRaw.trim() ? realmFilterRaw.trim() : undefined;

  /** @type {Record<string, unknown> | null} */
  let realmsResult = null;
  if (shouldInstall(install) && secrets && !skipRealms) {
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId}: reconciling realms/users/clients/identity providers …\n`,
    );
    realmsResult = await reconcileKeycloakRealmsForConfig(keycloakCfg, runOpts.vault, {
      skipRealms: false,
      skipIdentityProviders,
      prune,
      dryRun,
      rotateUserPasswords,
      rotateClientSecrets,
      rotateIdpSecrets,
      realmFilter,
      adminPassword: secrets.adminPassword,
      ctIp: ip,
      pveUser: pveSsh.user,
      pveHost: pveSsh.host,
      vmid: guestVmid,
      waitHealth: true,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    });
  } else if (skipRealms) {
    realmsResult = { ok: true, skipped: true, message: "realms skipped" };
  }

  const realmsOk = realmsResult == null || realmsResult.ok !== false;
  return {
    ok: provisionResult.ok && installResult.ok && realmsOk,
    system_id: systemId,
    host_id: hostId,
    mode,
    redeploy: skipProvision,
    ip,
    external_url: normalizeExternalUrl(keycloakCfg),
    database_mode: databaseConfig(keycloakCfg).mode,
    upstream_url: ip ? `http://${ip}:${hostPort(keycloakCfg)}` : null,
    result: provisionResult,
    install: installResult,
    realms: realmsResult,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Keycloak LXC via Proxmox (stderr log; JSON on stdout).\n`);
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
    deployments = resolveKeycloakDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createKeycloakVaultAccess();
  await vault.unlock({});
  const log = provisionLogFromConsole(console);
  /** @type {{ value: string | null }} */
  const ctPasswordCache = { value: null };
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await deployOne(deployment, flags, log, { ctPasswordCache, vault }));
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
