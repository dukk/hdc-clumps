#!/usr/bin/env node
/**
 * Azure deploy: Entra managed apps (default) or compute (--section compute).
 *
 * Usage: hdc run infrastructure azure deploy --
 *   [--section entra|compute]
 *   Entra: [--app <config-id>] [--dry-run]
 *   Compute: [--instance a] [--yes] [--accept-unknown-cost] …
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
import { applicationPassesFilter } from "hdc/package/azure-config.mjs";
import {
  createAzureRunContext,
  findLiveGraphAppForConfig,
  CLUMP_CONFIG_EXAMPLE,
} from "hdc/package/azure-run-context.mjs";
import { applyAppSync, planAppSync } from "hdc/package/azure-sync.mjs";
import { resolveAzureSection } from "hdc/package/section.mjs";
import { runAzureComputeDeploy } from "hdc/package/compute/run-compute-deploy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure azure query -- --section entra` to verify client IDs and drift.",
  "Grant admin consent in Entra portal when required_resource_access changes.",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[azure] ${line}\n`);
}

async function deployEntra(argv, flags) {
  const appFilter = flagGet(flags, "app");

  const reportCtx = createOperationReportContext({
    clumpId: "azure",
    clumpTitle: "Azure (Entra)",
    verb,
    argv,
    manifestNextSteps: MANIFEST_NEXT_STEPS,
  });

  log(`${verb}: starting entra${reportCtx.dryRun ? " (dry-run)" : ""}`);

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, api } = await createAzureRunContext(cfgRaw);
  log(`vault: ${config.automation.secret_value_vault_key} loaded`);

  const allLive = await api.listApplications();
  const filteredLive = allLive.filter((a) =>
    applicationPassesFilter(a.displayName, config.applicationFilter)
  );

  let appsToDeploy = config.managedApplications;
  if (appFilter) {
    const one = config.applicationsById.get(appFilter);
    if (!one) throw new Error(`Application not in config applications[]: ${appFilter}`);
    if (!one.managed) throw new Error(`Application is not managed: ${appFilter}`);
    appsToDeploy = [one];
  }

  if (!appsToDeploy.length) {
    pushWarning(reportCtx, "No managed applications in config");
  }

  let overallOk = true;
  /** @type {object[]} */
  const results = [];

  for (const cfgApp of appsToDeploy) {
    const live = findLiveGraphAppForConfig(cfgApp, filteredLive);
    const plan = planAppSync({ configApp: cfgApp, live });

    if (plan.action !== "create") {
      log(`app ${cfgApp.id}: skip (${plan.action})`);
      recordStep(reportCtx, {
        id: `app-${cfgApp.id}`,
        title: `Deploy: ${cfgApp.display_name}`,
        ran: false,
        skipReason: plan.action,
        ok: true,
        notes: [live ? `client_id=${live.appId}` : "already exists or unchanged"],
      });
      results.push({ config_id: cfgApp.id, action: "skip", reason: plan.action });
      continue;
    }

    log(`app ${cfgApp.id}: planning create`);
    const applyResult = await applyAppSync(api, plan, {
      dryRun: reportCtx.dryRun,
      log,
    });

    recordStep(reportCtx, {
      id: `app-${cfgApp.id}`,
      title: `Deploy: ${cfgApp.display_name}`,
      ran: true,
      ok: applyResult.ok,
      notes: applyResult.clientId ? [`client_id=${applyResult.clientId}`] : [],
    });

    results.push({
      config_id: cfgApp.id,
      action: applyResult.action,
      ok: applyResult.ok,
      client_id: applyResult.clientId,
      error: applyResult.error,
    });

    if (!applyResult.ok) overallOk = false;
  }

  setOutcome(reportCtx, { ok: overallOk, dryRun: reportCtx.dryRun, exitCode: overallOk ? 0 : 1 });
  setStdoutPayload(reportCtx, { section: "entra", deploy_results: results });

  await runOperationReportTail({
    ctx: reportCtx,
    clumpRoot,
    repoRoot: repoRoot(),
  });

  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  process.exitCode = overallOk ? 0 : 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const section = resolveAzureSection(flags, { allowAll: false, defaultSection: "entra" });
  if (section === "compute") {
    await runAzureComputeDeploy({ clumpRoot, argv, flags, verb });
    return;
  }
  await deployEntra(argv, flags);
}

main().catch(async (e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
