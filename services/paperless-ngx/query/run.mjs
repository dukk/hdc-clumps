#!/usr/bin/env node
/**
 * Query paperless-ngx deployments (config summary + optional live CT status).
 *
 * Usage: hdc run service paperless-ngx query -- [--instance a]
 *        hdc run service paperless-ngx query -- --live
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  listPaperlessNgxDeploymentSummaries,
  normalizePaperlessNgxConfig,
  resolvePaperlessNgxDeployments,
} from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "hdc/package/paperless-ngx-install.mjs";
import { queryPaperlessNgxInCt, queryPaperlessNgxOnGuest } from "hdc/package/query-status.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/paperless-ngx/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
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

  if (cfg) {
    try {
      const norm = normalizePaperlessNgxConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listPaperlessNgxDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolvePaperlessNgxDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
      for (const d of selected) {
        const px = isObject(d.proxmox) ? d.proxmox : {};
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        if (!hostId) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: "missing host_id",
          });
          continue;
        }
        try {
          if (d.mode === "proxmox-qemu") {
            const sshCfg = isObject(d.configure) && isObject(d.configure.ssh) ? d.configure.ssh : {};
            const q = isObject(px.qemu) ? px.qemu : {};
            const sshUser = resolveGuestSshUser(sshCfg.user);
            const ip = typeof q.ip === "string" ? q.ip.trim() : "";
            const sshHost =
              typeof sshCfg.host === "string" && sshCfg.host.trim()
                ? sshCfg.host.trim()
                : ip.split("/")[0];
            const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
            if (!sshHost) {
              liveResults.push({
                system_id: d.systemId,
                ok: false,
                message: "configure.ssh.host or proxmox.qemu.ip required",
              });
              continue;
            }
            errout.write(`[hdc] ${target} ${verb}: live query ${d.systemId} ${sshUser}@${sshHost} …\n`);
            const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
            const status = await queryPaperlessNgxOnGuest(exec, d.paperless_ngx, d.install, sshHost);
            liveResults.push({ system_id: d.systemId, ok: true, vmid, ...status });
          } else {
            const lxc = isObject(px.lxc) ? px.lxc : {};
            const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
            if (!Number.isFinite(vmid)) {
              liveResults.push({
                system_id: d.systemId,
                ok: false,
                message: "missing vmid",
              });
              continue;
            }
            errout.write(`[hdc] ${target} ${verb}: live query ${d.systemId} vmid ${vmid} …\n`);
            const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
            const status = await queryPaperlessNgxInCt(
              pveSsh.user,
              pveSsh.host,
              vmid,
              d.paperless_ngx,
              d.install,
            );
            liveResults.push({ system_id: d.systemId, ok: true, ...status });
          }
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
