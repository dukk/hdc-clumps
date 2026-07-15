#!/usr/bin/env node
/**
 * Maintain Keycloak: refresh compose env, optional image updates, reconcile realms/users/clients.
 *
 * Usage: hdc run service keycloak maintain -- [--instance a | --system-id keycloak-a] [--skip-upgrade]
 *        [--skip-realms] [--skip-identity-providers] [--prune] [--realm <id>] [--dry-run]
 *        [--rotate-user-passwords] [--rotate-client-secrets] [--rotate-idp-secrets]
 *        [--reapply-lxc-features]  Re-apply nesting/keyctl + Docker AppArmor workaround (default: always for privileged CTs)
 */
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { databasePasswordVaultKey, resolveKeycloakDeployments } from "hdc/package/deployments.mjs";
import { maintainKeycloakInCt, resolvePveSshForHost } from "hdc/package/keycloak-install.mjs";
import { reconcileKeycloakRealmsForConfig } from "hdc/package/keycloak-realms.mjs";
import {
  ensureLxcDockerApparmorWorkaround,
  pctRestart,
  pctSetFeatures,
} from "hdc/package/pve-pct-remote.mjs";
import { adminPasswordVaultKey } from "hdc/package/keycloak-render.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { createKeycloakVaultAccess } from "hdc/package/vault-deps.mjs";

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
  return { adminPassword, dbPassword };
}

/**
 * @param {ReturnType<typeof resolveKeycloakDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof createKeycloakVaultAccess>} vault
 * @param {ReturnType<typeof createPackageVaultAccess>} vaultAccess
 */
async function maintainOne(deployment, flags, vault, vaultAccess) {
  const { systemId, proxmox: px, keycloak, install } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!hostId || !Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, message: "missing host_id or vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} on ${hostId} …\n`);
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);

  const unprivileged =
    lxc.unprivileged === undefined ? 1 : Number(lxc.unprivileged) === 0 ? 0 : 1;
  const skipLxcFeatures = flagGet(flags, "skip-lxc-features", "skip_lxc_features") !== undefined;
  /** @type {Record<string, unknown> | null} */
  let lxcFeaturesResult = null;
  if (unprivileged === 0 && !skipLxcFeatures) {
    const lxcFeatures = typeof lxc.features === "string" ? lxc.features.trim() : "nesting=1,keyctl=1";
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId}: re-applying LXC features + Docker AppArmor workaround …\n`,
    );
    if (lxcFeatures) {
      const fr = pctSetFeatures(pveSsh.user, pveSsh.host, vmid, lxcFeatures, { capture: true });
      if (fr.status !== 0) {
        return {
          ok: false,
          system_id: systemId,
          host_id: hostId,
          vmid,
          message: `pct set -features failed (exit ${fr.status}): ${(fr.stderr || fr.stdout).trim()}`,
        };
      }
    }
    const ar = ensureLxcDockerApparmorWorkaround(pveSsh.user, pveSsh.host, vmid, { capture: true });
    if (ar.status !== 0) {
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        vmid,
        message: `LXC AppArmor workaround failed (exit ${ar.status}): ${(ar.stderr || ar.stdout).trim()}`,
      };
    }
    let restarted = false;
    if (/changed=1/.test(ar.stdout || "")) {
      const rr = pctRestart(pveSsh.user, pveSsh.host, vmid, { capture: true });
      if (rr.status !== 0) {
        return {
          ok: false,
          system_id: systemId,
          host_id: hostId,
          vmid,
          message: `pct restart failed (exit ${rr.status}): ${(rr.stderr || rr.stdout).trim()}`,
        };
      }
      restarted = true;
    }
    lxcFeaturesResult = {
      ok: true,
      features: lxcFeatures,
      apparmor_changed: /changed=1/.test(ar.stdout || ""),
      restarted,
    };
  }

  const secrets = await loadSecrets(deployment, vault);
  const keycloakCfg = isObject(keycloak) ? keycloak : {};
  const result = await maintainKeycloakInCt(
    pveSsh.user,
    pveSsh.host,
    vmid,
    keycloakCfg,
    isObject(install) ? install : {},
    secrets,
    { skipUpgrade },
  );

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
  if (result.ok && !skipRealms) {
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId}: reconciling realms/users/clients/identity providers …\n`,
    );
    realmsResult = await reconcileKeycloakRealmsForConfig(keycloakCfg, vault, {
      skipRealms: false,
      skipIdentityProviders,
      prune,
      dryRun,
      rotateUserPasswords,
      rotateClientSecrets,
      rotateIdpSecrets,
      realmFilter,
      adminPassword: secrets.adminPassword,
      ctIp: typeof result.ct_ip === "string" ? result.ct_ip : null,
      pveUser: pveSsh.user,
      pveHost: pveSsh.host,
      vmid,
      waitHealth: true,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    });
  } else if (skipRealms) {
    realmsResult = { ok: true, skipped: true, message: "realms skipped" };
  }

  const log = provisionLogFromConsole(console);
  const exec = createConfigureExec("pct", {
    user: pveSsh.user,
    host: pveSsh.host,
    vmid,
    pveHost: pveSsh.host,
  });
  const baseline = await ensureGuestLinuxBaseline({ exec, log, flags, vaultAccess, deployment, proxmoxPackageRoot: proxmoxRoot });
  const realmsOk = realmsResult == null || realmsResult.ok !== false;
  return {
    ok: result.ok && baseline.ok && realmsOk,
    system_id: systemId,
    host_id: hostId,
    vmid,
    skip_upgrade: skipUpgrade,
    message: result.message,
    lxc_features: lxcFeaturesResult,
    realms: realmsResult,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh Keycloak Docker stack (stderr log; JSON on stdout).\n`);
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
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainOne(deployment, flags, vault, vaultAccess));
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
