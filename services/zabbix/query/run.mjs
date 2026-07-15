#!/usr/bin/env node
/**
 * Query Zabbix deployments.
 *
 * Usage: hdc run service zabbix query -- [--instance a]
 *        hdc run service zabbix query -- --live
 */
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { listZabbixDeploymentSummaries, normalizeZabbixConfig, resolveZabbixDeployments } from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "hdc/package/zabbix-install.mjs";
import { queryZabbixInCt, queryZabbixOnHost } from "hdc/package/query-status.mjs";
import { tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/zabbix/config.example.json";
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
function loadCfg() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  if (loaded.ok && loaded.data) {
    pkgConfig = { data: loaded.data, path: loaded.path, source: loaded.source };
    return loaded;
  }
  if (loaded.missing) {
    const example = tryLoadClumpConfigFromClumpRoot(clumpRoot, { filename: "config.example.json" });
    if (example.ok && example.data) {
      pkgConfig = { data: example.data, path: example.path, source: example.source };
      return { ...example, example_fallback: true };
    }
  }
  return loaded;
}

async function main() {
  const loaded = loadCfg();
  const rel = relative(
    root,
    loaded.ok ? loaded.path : join(clumpRoot, "config.example.json"),
  ).replace(/\\/g, "/");
  const cfg = loaded.ok && isObject(loaded.data) ? loaded.data : null;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;
  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);

  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;
  if (cfg) {
    try {
      const norm = normalizeZabbixConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listZabbixDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];
  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveZabbixDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
      for (const d of selected) {
        const px = isObject(d.proxmox) ? d.proxmox : {};
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        try {
          if (d.mode === "proxmox-qemu") {
            const cfgObj = isObject(d.configure) ? d.configure : {};
            const ssh = isObject(cfgObj.ssh) ? cfgObj.ssh : {};
            const user = resolveGuestSshUser(ssh.user);
            const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
            if (!host) {
              liveResults.push({ system_id: d.systemId, ok: false, message: "configure.ssh.host required" });
              continue;
            }
            const q = isObject(px.qemu) ? px.qemu : {};
            const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
            const exec = createConfigureExec("ssh", { user, host });
            const status = queryZabbixOnHost(exec, d.zabbix, d.install, Number.isFinite(vmid) ? vmid : null);
            liveResults.push({ system_id: d.systemId, ok: true, ...status });
          } else {
            const lxc = isObject(px.lxc) ? px.lxc : {};
            const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
            if (!hostId || !Number.isFinite(vmid)) {
              liveResults.push({ system_id: d.systemId, ok: false, message: "missing host_id or vmid" });
              continue;
            }
            const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
            const status = queryZabbixInCt(pveSsh.user, pveSsh.host, vmid, d.zabbix, d.install);
            liveResults.push({ system_id: d.systemId, ok: true, ...status });
          }
        } catch (e) {
          liveResults.push({ system_id: d.systemId, ok: false, message: String(/** @type {Error} */ (e).message || e) });
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
    schema_version: schemaVersion,
    config_error: configError,
    deployments,
    live,
    live_results: live ? liveResults : undefined,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = configError ? 1 : 0;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
