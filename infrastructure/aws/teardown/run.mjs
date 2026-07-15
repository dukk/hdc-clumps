#!/usr/bin/env node
/**
 * AWS teardown: destroy managed resources (--resource or --all).
 *
 * Usage: hdc run infrastructure aws teardown --
 *   [--resource <id>] [--all] [--dry-run] [--yes] [--no-report]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  createOperationReportContext,
  runOperationReportTail,
  setOutcome,
  setStdoutPayload,
} from "hdc/package/operation-report.mjs";
import { confirmTeardown, teardownDryRun } from "../../../services/ollama/lib/teardown-confirm.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { collectAwsLiveState } from "hdc/package/aws-collect.mjs";
import { planAwsSync } from "hdc/package/aws-plan.mjs";
import { applyAwsPlan } from "hdc/package/aws-sync.mjs";
import { awsReportExtraSections } from "hdc/package/aws-report.mjs";
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
  const all = flagGet(flags, "all") !== undefined;

  if (!resourceFilter && !all) {
    throw new Error("teardown requires --resource <id> or --all");
  }

  const reportCtx = createOperationReportContext({
    clumpId: "aws",
    clumpTitle: "AWS infrastructure",
    verb,
    argv,
  });

  log(`${verb}: starting`);

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, client } = await createAwsRunContext(cfgRaw);
  const liveByKind = await collectAwsLiveState(client);

  const actions = planAwsSync({
    config,
    liveByKind,
    prune: true,
    resourceFilter: all ? undefined : resourceFilter,
  }).filter((a) => a.action === "delete");

  if (teardownDryRun(flags)) {
    log(`[dry-run] would destroy ${actions.length} resource(s)`);
    const payload = { ok: true, dry_run: true, plan_summary: actions, results: [] };
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

  const detail = all ? "all managed resources" : resourceFilter ?? "";
  const ok = await confirmTeardown("aws", detail, flags);
  if (!ok) {
    log("teardown cancelled");
    process.exitCode = 0;
    return;
  }

  const results = await applyAwsPlan({
    client,
    actions,
    dryRun: false,
    log,
  });

  const payload = { ok: true, plan_summary: actions, results };
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
