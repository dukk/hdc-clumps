#!/usr/bin/env node
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Maintain YaCy: refresh Docker images and recreate containers.
 *
 * Usage: hdc run service yacy maintain -- [--instance a | --system-id yacy-a]
 *        [--skip-clamav] [--skip-admin-user] [--skip-admin-password] [--skip-upgrade]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { adminPasswordVaultKey, resolveYacyDeployments } from "hdc/package/deployments.mjs";
import { maintainYacyInCt, resolvePveSshForHost } from "hdc/package/yacy-install.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/yacy/config.example.json";
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
 * @param {ReturnType<typeof resolveYacyDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 * @param {{ adminPassword: string | null; skipAdminPassword: boolean; skipUpgrade: boolean }} runOpts
 */
async function maintainOne(deployment, flags, vaultAccess, runOpts) {
  const { systemId, proxmox: px, yacy, install } = deployment;

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} on ${hostId} …\n`);
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const yacyCfg = isObject(yacy) ? yacy : {};
  const installCfg = isObject(install) ? install : {};
  const result = await maintainYacyInCt(pveSsh.user, pveSsh.host, vmid, yacyCfg, installCfg, {
    adminPassword: runOpts.skipAdminPassword ? null : runOpts.adminPassword,
    skipAdminPassword: runOpts.skipAdminPassword,
    skipUpgrade: runOpts.skipUpgrade,
  });
  const log = provisionLogFromConsole(console);
  const exec = createConfigureExec("pct", {
    user: pveSsh.user,
    host: pveSsh.host,
    vmid,
    pveHost: pveSsh.host,
  });
  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags,
    vaultAccess,
    deployment,
    proxmoxPackageRoot: proxmoxRoot,
  });
  return {
    ok: result.ok && baseline.ok,
    system_id: systemId,
    host_id: hostId,
    vmid,
    message: result.message,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh YaCy Docker stack (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const skipAdminPassword =
    flagGet(flags, "skip-admin-password", "skip_admin_password") !== undefined;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;

  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});

  /** @type {string | null} */
  let adminPassword = null;
  if (!skipAdminPassword) {
    const defaultsYacy = isObject(cfg.defaults) && isObject(cfg.defaults.yacy) ? cfg.defaults.yacy : {};
    const pwKey = adminPasswordVaultKey(defaultsYacy);
    errout.write(`[hdc] ${target} ${verb}: loading admin password from vault ${pwKey} …\n`);
    adminPassword = String(
      await vaultAccess.getSecret(pwKey, { promptLabel: `vault secret ${pwKey}` }),
    ).trim();
    if (!adminPassword) {
      errout.write(`[hdc] ${target} ${verb}: admin password required — set vault ${pwKey}\n`);
      process.stdout.write(
        `${JSON.stringify({ ok: false, target, verb, message: `missing vault ${pwKey}` }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  let deployments;
  try {
    deployments = resolveYacyDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(
        await maintainOne(deployment, flags, vaultAccess, {
          adminPassword,
          skipAdminPassword,
          skipUpgrade,
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

