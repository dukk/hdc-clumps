#!/usr/bin/env node
/**
 * OCI compute deploy: plan → cost estimate → confirm → apply.
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
import { resolveOciResourceFilter } from "hdc/package/oci-config.mjs";
import { ociComputeReportExtraSections } from "hdc/package/oci-compute-report.mjs";
import { ociStdoutPayload, runOciPlanApply } from "hdc/package/oci-verb-common.mjs";
import { createOciComputeRunContext, CLUMP_CONFIG_EXAMPLE } from "hdc/package/oci-run-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure oci-compute query -- --live` to verify resources.",
  "Update inventory sidecars with instance public/private IPs when created.",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[oci-compute] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const resourceFilterRaw = flagGet(flags, "resource");
  const instanceFilter = flagGet(flags, "instance");

  const reportCtx = createOperationReportContext({
    clumpId: "oci-compute",
    clumpTitle: "Oracle Cloud compute",
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

  const { config, client } = await createOciComputeRunContext(cfgRaw);
  log(`region: ${config.region}`);

  const resourceFilter = resolveOciResourceFilter(
    config,
    resourceFilterRaw ? { resource: resourceFilterRaw } : instanceFilter ? { resource: instanceFilter } : {},
  );

  recordStep(reportCtx, {
    id: "plan",
    title: "Plan and cost estimate",
    ran: true,
    ok: null,
    notes: [],
  });

  const outcome = await runOciPlanApply({
    config,
    client,
    flags,
    resourceFilter,
    log,
  });

  const payload = ociStdoutPayload(outcome);
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
      extraSections: ociComputeReportExtraSections,
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
    extraSections: ociComputeReportExtraSections,
  });
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
