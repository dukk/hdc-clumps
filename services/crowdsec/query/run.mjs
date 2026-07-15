#!/usr/bin/env node
/**
 * Query CrowdSec deployment status.
 *
 * Usage: hdc run service crowdsec query -- [--instance a | --system-id crowdsec-a]
 *        hdc run service crowdsec query -- --live
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listCrowdsecDeploymentSummaries,
  normalizeCrowdsecConfig,
  resolveCrowdsecDeployments,
  crowdsecLapiPort,
} from "hdc/package/deployments.mjs";
import {
  crowdsecInstalled,
  queryCrowdsecStatusInCt,
  readCtPrimaryIp,
  resolvePveSshForHost,
} from "hdc/package/crowdsec-install.mjs";
import { queryCollectionsInCt } from "hdc/package/crowdsec-collections.mjs";
import { queryUnifiSyslogInCt } from "hdc/package/crowdsec-unifi-syslog.mjs";
import {
  queryBouncersInCt,
  queryDecisionCountInCt,
} from "hdc/package/crowdsec-unifi-bouncer-sync.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/crowdsec/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let pkgConfig = null;

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function ensurePackageConfig() {
  if (!pkgConfig) {
    pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return pkgConfig;
}

function loadCfg() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  if (loaded.ok && loaded.data) {
    pkgConfig = { data: loaded.data, path: loaded.path, source: loaded.source };
  }
  return loaded;
}

async function main() {
  const loaded = loadCfg();
  const rel = relative(root, loaded.ok ? loaded.path : ensurePackageConfig().path).replace(/\\/g, "/");
  const cfg = loaded.ok && isObject(loaded.data) ? loaded.data : null;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;

  if (cfg) {
    try {
      const norm = normalizeCrowdsecConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listCrowdsecDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];
  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveCrowdsecDeployments(cfg, flags);
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
          liveResults.push({ system_id: d.systemId, ok: false, message: "missing host_id or vmid" });
          continue;
        }
        try {
          const ssh = resolvePveSshForHost(proxmoxRoot, hostId);
          const cs = isObject(d.crowdsec) ? d.crowdsec : {};
          const ip = readCtPrimaryIp(ssh.user, ssh.host, vmid);
          const installed = crowdsecInstalled(ssh.user, ssh.host, vmid);
          const status = queryCrowdsecStatusInCt(ssh.user, ssh.host, vmid);
          const port = crowdsecLapiPort(cs);
          const collections = queryCollectionsInCt(ssh.user, ssh.host, vmid, pctExec);
          const unifi_syslog = queryUnifiSyslogInCt(ssh.user, ssh.host, vmid, pctExec);
          const decisions = queryDecisionCountInCt(ssh.user, ssh.host, vmid);
          const bouncers = queryBouncersInCt(ssh.user, ssh.host, vmid);
          liveResults.push({
            ok: true,
            system_id: d.systemId,
            host_id: hostId,
            vmid,
            installed,
            ip,
            lapi_url: ip ? `http://${ip}:${port}` : null,
            collections,
            unifi_syslog,
            decisions,
            bouncers,
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
    ok: !configError && (loaded.ok || loaded.missing),
    target,
    verb,
    config_path: rel,
    config_loaded: loaded.ok,
    config_missing: loaded.missing === true,
    config_error: configError,
    schema_version: schemaVersion,
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
