#!/usr/bin/env node
/**
 * GCP OAuth maintain: validate config, import credentials to vault, print Console checklist.
 *
 * Usage: hdc run infrastructure gcp-oauth maintain --
 *   [--app <id>] [--import <path>] [--dry-run] [--skip-vault] [--no-derive]
 *   [--no-report] [--report <path>]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  createOperationReportContext,
  recordStep,
  runOperationReportTail,
  setOutcome,
  setStdoutPayload,
  pushWarning,
} from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { printConsoleChecklist } from "hdc/package/gcp-oauth-checklist.mjs";
import { collectGcpOauthState } from "hdc/package/gcp-oauth-collect.mjs";
import {
  findImportForConfigApp,
  normalizeGcpOauthConfig,
} from "hdc/package/gcp-oauth-config.mjs";
import { loadImportFile } from "hdc/package/gcp-oauth-import.mjs";
import {
  resolveEffectiveApplication,
  validateEffectiveApplication,
} from "hdc/package/gcp-oauth-validate.mjs";
import { createGcpOauthVaultAccess, writeVaultForApp } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/gcp-oauth/config.example.json";

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure gcp-oauth query -- --import <console-json>` after Console changes.",
  "Store client secrets in vault immediately after creating clients in Google Cloud Console.",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[gcp-oauth] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const appFilter = flagGet(flags, "app");
  const importPath = flagGet(flags, "import");
  const skipVault = flags["skip-vault"] === "1";
  const noDerive = flags["no-derive"] === "1";

  const reportCtx = createOperationReportContext({
    clumpId: "gcp-oauth",
    clumpTitle: "GCP OAuth (Google Auth Platform)",
    verb,
    argv,
    manifestNextSteps: MANIFEST_NEXT_STEPS,
  });

  log(`${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}`);

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const config = normalizeGcpOauthConfig(cfgRaw);
  const vault = createGcpOauthVaultAccess();

  let apps = config.applications;
  if (appFilter) {
    const one = config.applicationsById.get(appFilter);
    if (!one) throw new Error(`Application not in config applications[]: ${appFilter}`);
    apps = [one];
  }

  /** @type {ReturnType<typeof resolveEffectiveApplication>[]} */
  const effectiveApps = [];
  let overallOk = true;

  for (const cfgApp of apps) {
    let effective;
    try {
      effective = resolveEffectiveApplication(cfgApp, {
        noDerive,
        warn: (msg) => log(`warning: ${msg}`),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushWarning(reportCtx, msg);
      recordStep(reportCtx, {
        id: `validate-${cfgApp.id}`,
        title: `Validate: ${cfgApp.display_name}`,
        ran: true,
        ok: false,
        notes: [msg],
      });
      overallOk = false;
      continue;
    }

    const errors = validateEffectiveApplication(effective);
    if (errors.length) {
      for (const err of errors) pushWarning(reportCtx, `${cfgApp.id}: ${err}`);
      recordStep(reportCtx, {
        id: `validate-${cfgApp.id}`,
        title: `Validate: ${cfgApp.display_name}`,
        ran: true,
        ok: false,
        notes: errors,
      });
      overallOk = false;
      continue;
    }

    effectiveApps.push(effective);
    recordStep(reportCtx, {
      id: `validate-${cfgApp.id}`,
      title: `Validate: ${cfgApp.display_name}`,
      ran: true,
      ok: true,
      notes: [
        `${effective.redirect_uris.length} redirect URI(s), ${effective.javascript_origins.length} JS origin(s)`,
      ],
    });
  }

  printConsoleChecklist({
    consoleUrl: config.consoleUrl,
    projectId: config.projectId,
    applications: effectiveApps,
    log,
  });

  if (importPath && !skipVault) {
    log(`import: ${importPath}`);
    const importClients = loadImportFile(importPath);
    for (const cfgApp of apps) {
      const matched = findImportForConfigApp(cfgApp, importClients);
      if (!matched) {
        pushWarning(reportCtx, `${cfgApp.id}: no matching client in import file`);
        recordStep(reportCtx, {
          id: `vault-${cfgApp.id}`,
          title: `Vault import: ${cfgApp.display_name}`,
          ran: false,
          skipReason: "no import match",
          ok: false,
        });
        overallOk = false;
        continue;
      }
      try {
        const result = await writeVaultForApp(
          vault,
          cfgApp.vault,
          {
            client_id: matched.client_id,
            client_secret: matched.client_secret,
          },
          { dryRun: reportCtx.dryRun, log }
        );
        recordStep(reportCtx, {
          id: `vault-${cfgApp.id}`,
          title: `Vault import: ${cfgApp.display_name}`,
          ran: true,
          ok: true,
          notes: [
            cfgApp.vault.client_id_key,
            result.wrote_secret ? cfgApp.vault.client_secret_key : "secret skipped (not in import)",
          ],
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        pushWarning(reportCtx, `${cfgApp.id}: ${msg}`);
        recordStep(reportCtx, {
          id: `vault-${cfgApp.id}`,
          title: `Vault import: ${cfgApp.display_name}`,
          ran: true,
          ok: false,
          notes: [msg],
        });
        overallOk = false;
      }
    }
  } else if (importPath && skipVault) {
    log("import: skipped vault writes (--skip-vault)");
  }

  if (!reportCtx.dryRun) {
    const snapshot = await collectGcpOauthState({
      config,
      appFilterId: appFilter,
      importPath,
      noDerive,
      requireVault: false,
      vault,
      warn: (msg) => log(`warning: ${msg}`),
    });

    if (snapshot.has_drift && importPath) {
      pushWarning(reportCtx, "Drift remains after import — update Console redirect URIs");
      overallOk = false;
    }

    setStdoutPayload(reportCtx, {
      applications: snapshot.applications.map((a) => ({
        config_id: a.config_id,
        drift: a.drift.has_drift,
        vault: a.vault,
      })),
    });
  } else {
    log("dry-run: skipped post-run vault/drift snapshot");
  }

  await runOperationReportTail({
    reportCtx,
    clumpRoot,
    repoRoot: repoRoot(),
    ok: overallOk,
    payload: reportCtx.stdoutPayload,
    log,
  });

  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  process.exitCode = overallOk ? 0 : 1;
}

main().catch(async (e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
