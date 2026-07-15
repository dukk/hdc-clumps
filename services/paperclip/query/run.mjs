#!/usr/bin/env node
/**
 * Query paperclip deployments (config summary + optional live CT status).
 *
 * Usage: hdc run service paperclip query -- [--instance a]
 *        hdc run service paperclip query -- --live
 *        hdc run service paperclip query -- --bootstrap-company --dry-run
 *        hdc run service paperclip query -- --bootstrap-company --yes
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listPaperclipDeploymentSummaries,
  normalizePaperclipConfig,
  resolvePaperclipDeployments,
} from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "hdc/package/paperclip-install.mjs";
import { queryPaperclipInCt } from "hdc/package/query-status.mjs";
import { bootstrapPaperclipCompany, resolvePaperclipCompanyConfig } from "hdc/package/paperclip-company-bootstrap.mjs";
import { createPaperclipVaultAccess } from "hdc/package/paperclip-vault-deps.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/paperclip/config.example.json";
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
  const loaded = loadCfg();
  const cfg = loaded.ok && isObject(loaded.data) ? loaded.data : null;
  const rel =
    loaded.ok && loaded.path
      ? relative(root, loaded.path).replace(/\\/g, "/")
      : CLUMP_CONFIG_EXAMPLE;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;
  const bootstrapCompany = flagGet(flags, "bootstrap-company", "bootstrap_company") !== undefined;
  const bootstrapYes = flagGet(flags, "yes") !== undefined;
  const bootstrapDryRun = flagGet(flags, "dry-run", "dry_run") !== undefined || !bootstrapYes;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);

  if (bootstrapCompany) {
    if (!cfg) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: "config required for --bootstrap-company" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const vault = createPaperclipVaultAccess();
    await vault.unlock({});
    const companyCfg = resolvePaperclipCompanyConfig(cfg);
    const apiKey = String(
      await vault.getSecret(companyCfg.api_key_vault_key, {
        optional: bootstrapDryRun,
        promptLabel: "Paperclip API key",
      }),
    ).trim();
    if (!bootstrapDryRun && !apiKey) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: `missing vault ${companyCfg.api_key_vault_key}` }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    errout.write(
      `[hdc] ${target} ${verb}: bootstrap company ${bootstrapDryRun ? "(dry-run)" : ""} …\n`,
    );
    try {
      const result = await bootstrapPaperclipCompany({
        cfg,
        apiKey: apiKey || "dry-run-placeholder",
        dryRun: bootstrapDryRun,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errout.write(`[hdc] ${target} ${verb}: bootstrap failed: ${msg}\n`);
      process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;

  if (cfg) {
    try {
      const norm = normalizePaperclipConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listPaperclipDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolvePaperclipDeployments(cfg, flags);
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
          const status = await queryPaperclipInCt(
            pveSsh.user,
            pveSsh.host,
            vmid,
            d.paperclip,
            d.install,
          );
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
