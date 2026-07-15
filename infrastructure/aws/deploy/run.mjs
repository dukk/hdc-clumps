#!/usr/bin/env node
/**
 * AWS deploy: plan → cost estimate → confirm → apply managed resources.
 *
 * Usage: hdc run infrastructure aws deploy --
 *   [--resource <id>] [--dry-run] [--yes] [--skip-cost-confirm] [--no-report]
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
} from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { awsReportExtraSections } from "hdc/package/aws-report.mjs";
import { awsStdoutPayload, runAwsPlanApply } from "hdc/package/aws-verb-common.mjs";
import { createAwsRunContext, CLUMP_CONFIG_EXAMPLE } from "hdc/package/aws-run-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure aws query --` to verify live state.",
  "Update inventory sidecars with EC2 private IPs when instances were created.",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[aws] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const resourceFilter = flagGet(flags, "resource");

  const reportCtx = createOperationReportContext({
    clumpId: "aws",
    clumpTitle: "AWS infrastructure",
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

  const { config, client } = await createAwsRunContext(cfgRaw);
  log(`region: ${config.region}`);

  recordStep(reportCtx, {
    id: "plan",
    title: "Plan and cost estimate",
    ran: true,
    ok: null,
    notes: [],
  });

  const outcome = await runAwsPlanApply({
    config,
    client,
    flags,
    resourceFilter,
    log,
  });

  const payload = awsStdoutPayload(outcome);
  if (outcome.aborted) {
    log(outcome.dry_run ? "deploy dry-run complete" : "deploy aborted");
    setStdoutPayload(reportCtx, payload);
    setOutcome(reportCtx, { ok: true, exitCode: 0 });
    console.log(JSON.stringify(payload, null, 2));
    await runOperationReportTail({
      clumpRoot,
      reportCtx,
      repoRoot: repoRoot(),
      payload,
      ok: true,
      log,
      extraSections: awsReportExtraSections,
    });
    return;
  }

  recordStep(reportCtx, {
    id: "apply",
    title: "Apply plan",
    ran: true,
    ok: true,
    notes: [`${outcome.results.length} resource operations`],
  });

  setStdoutPayload(reportCtx, payload);
  setOutcome(reportCtx, { ok: true, exitCode: 0 });
  console.log(JSON.stringify(payload, null, 2));
  await runOperationReportTail({
    clumpRoot,
    reportCtx,
    repoRoot: repoRoot(),
    payload,
    ok: true,
    log,
    extraSections: awsReportExtraSections,
  });
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
