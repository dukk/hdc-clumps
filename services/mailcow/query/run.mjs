#!/usr/bin/env node
/**
 * Query Mailcow deployments (config summary + optional live CT/API status).
 *
 * Usage: hdc run service mailcow query -- [--instance a]
 *        hdc run service mailcow query -- --live
 */
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import {
  listMailcowDeploymentSummaries,
  normalizeMailcowConfig,
  resolveMailcowDeployments,
} from "hdc/package/deployments.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolvePveSshForHost } from "hdc/package/mailcow-install.mjs";
import { queryMailcowInCt, queryMailcowOnHost } from "hdc/package/query-status.mjs";
import { createMailcowVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolveMailcowApiKey } from "hdc/package/vault-secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/mailcow/config.example.json";
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
      const norm = normalizeMailcowConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listMailcowDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveMailcowDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
      const vault = createMailcowVaultAccess();
      for (const d of selected) {
        const px = isObject(d.proxmox) ? d.proxmox : {};
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        const mailcowCfg = isObject(d.mailcow) ? d.mailcow : {};
        const apiKey = await resolveMailcowApiKey(vault, mailcowCfg, { required: false });

        if (d.mode === "proxmox-qemu" || d.mode === "configure-only") {
          const cfg = isObject(d.configure) ? d.configure : {};
          const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
          const user = resolveGuestSshUser(ssh.user);
          const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
          if (!host) {
            liveResults.push({
              system_id: d.systemId,
              ok: false,
              message: "missing configure.ssh.host",
            });
            continue;
          }
          errout.write(`[hdc] ${target} ${verb}: live query ${d.systemId} ${host} (QEMU) …\n`);
          try {
            const exec = createConfigureExec("ssh", { user, host });
            const status = await queryMailcowOnHost(exec, mailcowCfg, d.install, apiKey);
            if (status.dns_checklist_markdown) {
              errout.write(`[hdc] ${target} ${verb}: DNS checklists:\n${status.dns_checklist_markdown}\n`);
            }
            if (Array.isArray(status.missing_domains) && status.missing_domains.length) {
              errout.write(
                `[hdc] ${target} ${verb}: missing on Mailcow: ${status.missing_domains.join(", ")}\n`,
              );
            }
            if (Array.isArray(status.extra_domains) && status.extra_domains.length) {
              errout.write(
                `[hdc] ${target} ${verb}: extra on Mailcow (not in config): ${status.extra_domains.join(", ")}\n`,
              );
            }
            liveResults.push({ system_id: d.systemId, ok: true, ...status });
          } catch (e) {
            liveResults.push({
              system_id: d.systemId,
              ok: false,
              message: String(/** @type {Error} */ (e).message || e),
            });
          }
          continue;
        }

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
          const status = await queryMailcowInCt(
            pveSsh.user,
            pveSsh.host,
            vmid,
            mailcowCfg,
            d.install,
            apiKey,
          );
          if (status.dns_checklist_markdown) {
            errout.write(`[hdc] ${target} ${verb}: DNS checklists:\n${status.dns_checklist_markdown}\n`);
          }
          if (Array.isArray(status.missing_domains) && status.missing_domains.length) {
            errout.write(
              `[hdc] ${target} ${verb}: missing on Mailcow: ${status.missing_domains.join(", ")}\n`,
            );
          }
          if (Array.isArray(status.extra_domains) && status.extra_domains.length) {
            errout.write(
              `[hdc] ${target} ${verb}: extra on Mailcow (not in config): ${status.extra_domains.join(", ")}\n`,
            );
          }
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
