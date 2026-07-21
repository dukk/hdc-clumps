#!/usr/bin/env node
/**
 * Query Homepage deployments (config summary + optional live CT status).
 *
 * Usage: hdc run service homepage query -- [--instance a]
 *        hdc run service homepage query -- --live
 *        hdc run service homepage query -- --lint
 *        hdc run service homepage query -- --failing-only
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listHomepageDeploymentSummaries,
  normalizeHomepageConfig,
  resolveHomepageDeployments,
} from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "hdc/package/homepage-install.mjs";
import { queryHomepageInCt } from "hdc/package/query-status.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { lintHomepageServicesFromConfig } from "hdc/package/homepage-services-lint.mjs";
import { loadHomepageConfigFiles } from "hdc/package/homepage-config-load.mjs";
import {
  parseHomepageMonitorTargetsFromYaml,
  probeHomepageMonitorTargets,
} from "hdc/package/homepage-sitemonitor-probe.mjs";

const here = dirname(fileURLToPath(import.meta.url));
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

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function loadCfg() {
  const loaded = tryLoadClumpConfigFromClumpRoot(packageRoot, { exampleRel: PACKAGE_CONFIG_EXAMPLE });
  if (loaded.ok && loaded.data) {
    _pkgConfig = { data: loaded.data, path: loaded.path, source: loaded.source };
  }
  return loaded;
}

async function main() {
  const rel = relative(root, ensurePackageConfig().path).replace(/\\/g, "/");
  const loaded = loadCfg();
  const cfg = loaded.ok && isObject(loaded.data) ? loaded.data : null;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;
  const lintOnly = flagGet(flags, "lint") !== undefined;
  const failingOnly = flagGet(flags, "failing-only") !== undefined;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;

  /** @type {Record<string, unknown> | null} */
  let lintResult = null;

  if (cfg && failingOnly) {
    try {
      const deployment = resolveHomepageDeployments(cfg, flags)[0];
      const homepage = deployment?.homepage && isObject(deployment.homepage) ? deployment.homepage : {};
      const loadedFiles = loadHomepageConfigFiles(homepage, packageRoot);
      const targets = parseHomepageMonitorTargetsFromYaml(loadedFiles.servicesYaml);
      errout.write(
        `[hdc] ${target} ${verb}: failing-only probe of ${targets.length} siteMonitor/ping target(s) …\n`,
      );
      const probe = await probeHomepageMonitorTargets(targets, {
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });

      /** @type {Record<string, unknown>[]} */
      const dashboardFailures = [];
      if (deployment) {
        const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        const lxc = isObject(px.lxc) ? px.lxc : {};
        const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
        if (hostId && Number.isFinite(vmid)) {
          try {
            const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
            const status = await queryHomepageInCt(
              pveSsh.user,
              pveSsh.host,
              vmid,
              deployment.homepage,
              deployment.install,
            );
            if (!status.http_ok) {
              dashboardFailures.push({
                kind: "dashboard",
                system_id: deployment.systemId,
                target: status.upstream_url ?? status.web_url ?? null,
                error: status.http_error ?? "homepage HTTP probe failed",
              });
            }
          } catch (e) {
            dashboardFailures.push({
              kind: "dashboard",
              system_id: deployment.systemId,
              error: String(/** @type {Error} */ (e).message || e),
            });
          }
        }
      }

      const failing = [...probe.failing, ...dashboardFailures];
      const ok = failing.length === 0;
      process.stdout.write(
        `${JSON.stringify(
          {
            ok,
            target,
            verb,
            failing_only: true,
            target_count: probe.target_count,
            failing_count: failing.length,
            failing,
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = ok ? 0 : 1;
      return;
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: failing-only check failed: ${msg}\n`);
      process.stdout.write(
        `${JSON.stringify({ ok: false, target, verb, failing_only: true, message: msg }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (cfg && lintOnly) {
    try {
      const deployment = resolveHomepageDeployments(cfg, flags)[0];
      const homepage = deployment?.homepage && isObject(deployment.homepage) ? deployment.homepage : {};
      const loaded = loadHomepageConfigFiles(homepage, packageRoot);
      lintResult = lintHomepageServicesFromConfig(homepage, loaded.servicesYaml, packageRoot);
      for (const warning of lintResult.warnings) {
        errout.write(`[hdc] homepage lint WARN: ${warning}\n`);
      }
      if (!lintResult.ok) {
        for (const err of lintResult.errors) {
          errout.write(`[hdc] homepage lint ERROR: ${err}\n`);
        }
      } else {
        errout.write(`[hdc] homepage lint OK (${lintResult.service_count} service tile(s)).\n`);
      }
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  if (cfg) {
    try {
      const norm = normalizeHomepageConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listHomepageDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveHomepageDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
      for (const d of selected) {
        const px = isObject(d.proxmox) ? d.proxmox : {};
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        const lxc = isObject(px.lxc) ? px.lxc : {};
        const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
        if (!hostId || !Number.isFinite(vmid)) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: "missing host_id or vmid",
          });
          continue;
        }
        errout.write(`[hdc] ${target} ${verb}: live query ${d.systemId} vmid ${vmid} …\n`);
        try {
          const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
          const status = await queryHomepageInCt(pveSsh.user, pveSsh.host, vmid, d.homepage, d.install);
          liveResults.push({ system_id: d.systemId, ok: true, ...status });
        } catch (e) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: String(/** @type {Error} */ (e).message || e),
          });
        }
      }
    }
  }

  const payload = {
    ok: !configError && (loaded.ok || loaded.missing) && (lintResult ? lintResult.ok : true),
    target,
    verb,
    config_path: rel,
    config_loaded: loaded.ok,
    config_missing: loaded.missing === true,
    schema_version: schemaVersion,
    config_error: configError,
    deployments,
    lint: lintOnly ? lintResult : undefined,
    live,
    live_results: live ? liveResults : undefined,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = configError || (lintResult && !lintResult.ok) ? 1 : 0;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
