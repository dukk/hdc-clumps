#!/usr/bin/env node
/**
 * AWS maintain: reconcile config drift; creates trigger cost gate.
 *
 * Usage: hdc run infrastructure aws maintain --
 *   [--resource <id>] [--prune] [--dry-run] [--yes] [--skip-cost-confirm]
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
import { awsReportExtraSections } from "hdc/package/aws-report.mjs";
import { awsStdoutPayload, runAwsPlanApply } from "hdc/package/aws-verb-common.mjs";
import { createAwsRunContext, CLUMP_CONFIG_EXAMPLE } from "hdc/package/aws-run-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

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
  const prune = flagGet(flags, "prune") !== undefined;

  const reportCtx = createOperationReportContext({
    clumpId: "aws",
    clumpTitle: "AWS infrastructure",
    verb,
    argv,
  });

  log(`${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}${prune ? " (prune)" : ""}`);

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, client } = await createAwsRunContext(cfgRaw);

  if (prune) {
    pushWarning(reportCtx, "prune enabled: live HDC-tagged resources not in config may be deleted.");
  }

  const outcome = await runAwsPlanApply({
    config,
    client,
    flags,
    prune,
    resourceFilter,
    log,
  });

  const payload = awsStdoutPayload(outcome);
  recordStep(reportCtx, {
    id: "maintain",
    title: "Reconcile AWS resources",
    ran: true,
    ok: !outcome.aborted || outcome.dry_run,
    notes: outcome.aborted ? ["aborted or dry-run"] : [`${outcome.results.length} operations`],
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
