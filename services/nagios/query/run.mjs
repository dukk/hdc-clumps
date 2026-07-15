#!/usr/bin/env node
/**
 * Query Nagios deployment status.
 *
 * Usage: hdc run service nagios query -- [--instance a | --system-id nagios-a]
 *        hdc run service nagios query -- --live
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listNagiosDeploymentSummaries,
  normalizeNagiosConfig,
  resolveNagiosDeployments,
} from "hdc/package/deployments.mjs";
import { loadNagiosBindBundle } from "hdc/package/bind-monitored-hosts.mjs";
import { readCtPrimaryIp, resolvePveSshForHost } from "hdc/package/nagios-install.mjs";
import { queryNagiosStatusInCt } from "hdc/package/nagios-configure.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/nagios/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

function loadCfg() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
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

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;
  /** @type {number | null} */
  let bindHostCount = null;
  /** @type {string | null} */
  let bindConfigPath = null;

  if (cfg) {
    try {
      const norm = normalizeNagiosConfig(cfg);
      schemaVersion = norm.schemaVersion;
      bindConfigPath = norm.bindConfigPath;
      deployments = listNagiosDeploymentSummaries(cfg);
      const bundle = loadNagiosBindBundle(root, norm.bindConfigPath);
      bindHostCount = bundle.stats.hostCount;
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveNagiosDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (!configError && selected) {
      errout.write(`[hdc] ${target} ${verb}: live status for ${selected.length} deployment(s) …\n`);
      for (const d of selected) {
        const px = isObject(d.proxmox) ? d.proxmox : null;
        const hostId = px && typeof px.host_id === "string" ? px.host_id.trim() : "";
        const lxc = px && isObject(px.lxc) ? px.lxc : {};
        const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
        if (!hostId || !Number.isFinite(vmid)) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: "missing host_id or vmid",
          });
          continue;
        }
        try {
          const ssh = resolvePveSshForHost(proxmoxRoot, hostId);
          const status = queryNagiosStatusInCt(ssh.user, ssh.host, vmid);
          const ip = readCtPrimaryIp(ssh.user, ssh.host, vmid);
          liveResults.push({
            system_id: d.systemId,
            host_id: hostId,
            vmid,
            ip,
            ui_url: ip ? `http://${ip}/nagios4` : null,
            ...status,
          });
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
    ok: !configError && (loaded.ok || false),
    target,
    verb,
    config_path: rel,
    config_loaded: loaded.ok,
    config_missing: loaded.missing === true,
    config_error: configError || (loaded.error ?? null),
    schema_version: schemaVersion,
    bind_config_path: bindConfigPath,
    bind_host_count: bindHostCount,
    deployments,
    live,
    live_results: live ? liveResults : undefined,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = payload.ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
