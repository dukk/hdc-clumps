#!/usr/bin/env node
/**
 * Maintain Homepage: re-push .env from config, refresh Docker images, guest Linux baseline.
 *
 * Usage: hdc run service homepage maintain -- [--instance a | --system-id homepage-a]
 *        hdc run service homepage maintain -- [--skip-upgrade] [--skip-clamav]
 */
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import {
  homepageWidgetPackageRoots,
  runHomepageServicesLint,
} from "hdc/package/homepage-maintain-preflight.mjs";
import { resolveAllHomepageWidgetEnv } from "hdc/package/homepage-widget-env.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { resolveHomepageDeployments } from "hdc/package/deployments.mjs";
import { maintainHomepageInCt, resolvePveSshForHost } from "hdc/package/homepage-install.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const packageRoot = join(here, "..");
const PACKAGE_CONFIG_EXAMPLE = "clumps/services/homepage/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(packageRoot, { exampleRel: PACKAGE_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
const widgetRoots = homepageWidgetPackageRoots(root);

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolveHomepageDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 * @param {ReturnType<typeof createNodeCliDeps>} cliDeps
 */
async function maintainOne(deployment, flags, vaultAccess, cliDeps) {
  const { systemId, proxmox: px, homepage, install } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;

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
  const homepageCfg = isObject(homepage) ? homepage : {};
  const installCfg = isObject(install) ? install : {};

  /** @type {string[]} */
  let widgetEnvLines = [];
  /** @type {Record<string, unknown>} */
  let widgetMeta = {};
  /** @type {import("../lib/homepage-bind-widget.mjs").HomepageBindStatsFile[]} */
  let widgetStatsFiles = [];
  try {
    runHomepageServicesLint(homepageCfg, packageRoot);
    const widgetEnv = await resolveAllHomepageWidgetEnv({
      homepage: homepageCfg,
      vaultAccess,
      env: process.env,
      spawnSync: cliDeps.spawnSync,
      readLineQuestion: cliDeps.readLineQuestion,
      ...widgetRoots,
    });
    widgetEnvLines = widgetEnv.lines;
    widgetMeta = widgetEnv.meta;
    widgetStatsFiles = widgetEnv.statsFiles ?? [];
  } catch (e) {
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      message: String(/** @type {Error} */ (e).message || e),
    };
  }

  const result = await maintainHomepageInCt(pveSsh.user, pveSsh.host, vmid, homepageCfg, installCfg, packageRoot, {
    skipUpgrade,
    widgetEnvLines,
    statsFiles: widgetStatsFiles,
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
    skip_upgrade: skipUpgrade,
    web_url: result.web_url ?? null,
    upstream_url: result.upstream_url ?? null,
    widgets: widgetMeta,
    message: result.message,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh Homepage Docker stack (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "package config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const cliDeps = createNodeCliDeps();
  let deployments;
  try {
    deployments = resolveHomepageDeployments(cfg, flags);
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
      results.push(await maintainOne(deployment, flags, vaultAccess, cliDeps));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok);
  const payload = { ok, target, verb, count: results.length, results };
  runOperationReportTail({
    clumpRoot: packageRoot,
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
