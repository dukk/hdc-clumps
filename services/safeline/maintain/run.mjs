#!/usr/bin/env node
/**
 * Maintain SafeLine WAF: re-push compose/.env, refresh images, sync sites[], guest baseline.
 *
 * Usage: hdc run service safeline maintain -- [--instance a | --system-id safeline-a]
 *        hdc run service safeline maintain -- [--skip-upgrade] [--skip-sites] [--skip-clamav] [--prune] [--site <id>]
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
import { resolveSafelineDeployments } from "hdc/package/deployments.mjs";
import { maintainSafelineInCt, resolvePveSshForHost } from "hdc/package/safeline-install.mjs";
import { syncSafelineSites } from "hdc/package/safeline-sites-run.mjs";
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
 * @param {ReturnType<typeof resolveSafelineDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 * @param {string} postgresPassword
 * @param {string | null} apiToken
 */
async function maintainOne(deployment, flags, vaultAccess, postgresPassword, apiToken) {
  const { systemId, proxmox: px, safeline, install, sites } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  const skipSites = flagGet(flags, "skip-sites", "skip_sites") !== undefined;
  const prune = flagGet(flags, "prune") !== undefined;
  const siteFilter = flagGet(flags, "site") ?? null;

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
  const safelineCfg = isObject(safeline) ? safeline : {};
  const installCfg = isObject(install) ? install : {};

  const result = await maintainSafelineInCt(
    pveSsh.user,
    pveSsh.host,
    vmid,
    safelineCfg,
    installCfg,
    postgresPassword,
    { skipUpgrade },
  );

  /** @type {Record<string, unknown> | null} */
  let sitesResult = null;
  if (!skipSites && sites.length > 0) {
    if (!apiToken) {
      errout.write(`[hdc] ${target} ${verb}: API token missing — skipping site sync.\n`);
      sitesResult = { ok: true, skipped: true, reason: "api_token_missing" };
    } else {
      try {
        sitesResult = await syncSafelineSites(
          pveSsh.user,
          pveSsh.host,
          vmid,
          safelineCfg,
          sites,
          apiToken,
          { prune, siteFilter },
        );
      } catch (e) {
        return {
          ok: false,
          system_id: systemId,
          host_id: hostId,
          vmid,
          message: String(/** @type {Error} */ (e).message || e),
        };
      }
      if (!sitesResult.ok) {
        return {
          ok: false,
          system_id: systemId,
          host_id: hostId,
          vmid,
          sites: sitesResult,
          message: "site sync failed",
        };
      }
    }
  }

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
    deployment: { systemId, proxmox: px, mode: deployment.mode },
    proxmoxPackageRoot: proxmoxRoot,
  });

  return {
    ok: result.ok && baseline.ok,
    system_id: systemId,
    host_id: hostId,
    vmid,
    skip_upgrade: skipUpgrade,
    skip_sites: skipSites,
    prune,
    site_filter: siteFilter,
    url: result.url ?? null,
    mgt_url: result.mgt_url ?? null,
    sites: sitesResult,
    message: result.message,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh SafeLine stack (stderr log; JSON on stdout).\n`);

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
  const vaultAccess = createPackageVaultAccess();
  const results = [];
  for (const deployment of deployments) {
    try {
      const safelineCfg = isObject(deployment.safeline) ? deployment.safeline : {};
      const { password } = await resolvePostgresPassword(vault, safelineCfg);
      const { token } = await resolveApiToken(vault, safelineCfg);
      results.push(await maintainOne(deployment, flags, vaultAccess, password, token));
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
