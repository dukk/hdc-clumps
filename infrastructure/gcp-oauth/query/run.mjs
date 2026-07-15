#!/usr/bin/env node
/**
 * GCP OAuth query: diff desired clients vs Console import and vault (JSON on stdout).
 *
 * Usage: hdc run infrastructure gcp-oauth query --
 *   [--app <id>] [--import <path>] [--require-vault] [--no-derive]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { collectGcpOauthState } from "hdc/package/gcp-oauth-collect.mjs";
import { normalizeGcpOauthConfig } from "hdc/package/gcp-oauth-config.mjs";
import { createGcpOauthVaultAccess } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/gcp-oauth/config.example.json";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[gcp-oauth] ${line}\n`);
}

async function main() {
  log(`${verb}: starting`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const appId = flagGet(flags, "app");
  const importPath = flagGet(flags, "import");
  const requireVault = flags["require-vault"] === "1";
  const noDerive = flags["no-derive"] === "1";

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const config = normalizeGcpOauthConfig(cfgRaw);
  const vault = createGcpOauthVaultAccess();

  if (importPath) log(`import: ${importPath}`);
  else log("import: not provided (desired config and vault only)");

  const state = await collectGcpOauthState({
    config,
    appFilterId: appId,
    importPath,
    noDerive,
    requireVault,
    vault,
    warn: (msg) => log(`warning: ${msg}`),
  });

  const ok = !state.has_drift && !state.vault_incomplete;

  const payload = {
    ok,
    verb: "query",
    package: "gcp-oauth",
    config_source: source,
    gcp: {
      project_id: config.projectId || null,
      console_url: config.consoleUrl || null,
    },
    import_path: importPath ?? null,
    import_client_count: state.import_client_count,
    applications: state.applications,
    collected_at: new Date().toISOString(),
  };

  if (state.has_drift) log("warning: one or more applications have drift vs import");
  if (state.vault_incomplete) log("warning: vault keys missing (--require-vault)");
  log(`done: ${state.applications.length} application(s) in report`);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
