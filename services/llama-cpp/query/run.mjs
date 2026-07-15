#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Query llama-cpp deployments (config summary + optional live status).
 *
 * Usage: hdc run service llama-cpp query -- [--instance a]
 *        hdc run service llama-cpp query -- --live
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listLlamaCppDeploymentSummaries,
  normalizeLlamaCppConfig,
  resolveLlamaCppDeployments,
} from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "hdc/package/llama-cpp-install.mjs";
import { queryLlamaCppInCt, queryLlamaCppViaSsh } from "hdc/package/query-status.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/llama-cpp/config.example.json";
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
  const loaded = loadCfg();
  const rel = loaded.ok && loaded.path ? relative(root, loaded.path).replace(/\\/g, "/") : CLUMP_CONFIG_EXAMPLE;
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
      const norm = normalizeLlamaCppConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listLlamaCppDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveLlamaCppDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (!configError && selected) {
      errout.write(`[hdc] ${target} ${verb}: live status for ${selected.length} deployment(s) …\n`);
      for (const d of selected) {
        const px = isObject(d.proxmox) ? d.proxmox : null;
        const hostId =
          px && typeof px.host_id === "string" ? px.host_id.trim() : "";
        if (!hostId) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: "missing host_id",
          });
          continue;
        }
        try {
          const serverCfg = isObject(d.server) ? d.server : {};
          if (d.mode === "proxmox-qemu") {
            const configure = isObject(d.configure) ? d.configure : {};
            const sshCfg = isObject(configure.ssh) ? configure.ssh : {};
            const q = px && isObject(px.qemu) ? px.qemu : {};
            const sshUser =
              resolveGuestSshUser(sshCfg.user);
            const ip = typeof q.ip === "string" ? q.ip.trim() : "";
            const sshHost =
              typeof sshCfg.host === "string" && sshCfg.host.trim()
                ? sshCfg.host.trim()
                : ip.split("/")[0];
            if (!sshHost) {
              liveResults.push({
                system_id: d.systemId,
                ok: false,
                message: "missing configure.ssh.host or proxmox.qemu.ip",
              });
              continue;
            }
            const status = await queryLlamaCppViaSsh(sshUser, sshHost, serverCfg);
            liveResults.push({ system_id: d.systemId, host_id: hostId, ok: true, ...status });
          } else {
            const lxc = px && isObject(px.lxc) ? px.lxc : {};
            const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
            if (!Number.isFinite(vmid)) {
              liveResults.push({
                system_id: d.systemId,
                ok: false,
                message: "missing vmid",
              });
              continue;
            }
            const ssh = resolvePveSshForHost(proxmoxRoot, hostId);
            const status = await queryLlamaCppInCt(ssh.user, ssh.host, vmid, serverCfg);
            liveResults.push({ system_id: d.systemId, host_id: hostId, ok: true, ...status });
          }
        } catch (e) {
          liveResults.push({
            system_id: d.systemId,
            host_id: hostId,
            ok: false,
            message: String(/** @type {Error} */ (e).message || e),
          });
        }
      }
    }
  }

  const defaultMode =
    cfg && isObject(cfg.defaults) && typeof cfg.defaults.mode === "string"
      ? cfg.defaults.mode
      : null;

  const payload = {
    target,
    verb: "query",
    ok: Boolean(cfg) && !configError,
    config_path: rel,
    schema_version: schemaVersion,
    deploy_mode: defaultMode,
    deployments,
    live: live ? liveResults : undefined,
    config_error: configError,
    message: configError
      ? `Config error: ${configError}`
      : cfg
        ? `${deployments.length} deployment(s) configured. Deploy: hdc run service llama-cpp deploy — Live status: hdc run service llama-cpp query -- --live`
        : `Copy clumps/services/llama-cpp/config.example.json to config.json.`,
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

