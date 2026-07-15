#!/usr/bin/env node
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
import { resolveOciResourceFilter } from "hdc/package/oci-config.mjs";
import { collectOciLiveState } from "hdc/package/oci-collect.mjs";
import { planOciSync } from "hdc/package/oci-plan.mjs";
import { applyOciPlan } from "hdc/package/oci-sync.mjs";
import { ociComputeReportExtraSections } from "hdc/package/oci-compute-report.mjs";
import { createOciComputeRunContext, CLUMP_CONFIG_EXAMPLE } from "hdc/package/oci-run-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

function log(line) {
  errout.write(`[oci-compute] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const resourceFilterRaw = flagGet(flags, "resource");
  const instanceFilter = flagGet(flags, "instance");
  const all = flagGet(flags, "all") !== undefined;

  if (!resourceFilterRaw && !instanceFilter && !all) {
    throw new Error("teardown requires --resource <id>, --instance <id>, or --all");
  }

  const reportCtx = createOperationReportContext({
    clumpId: "oci-compute",
    clumpTitle: "Oracle Cloud compute",
    verb,
    argv,
  });

  log(`${verb}: starting`);

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, client } = await createOciComputeRunContext(cfgRaw);
  const live = await collectOciLiveState(client, config);

  const resourceFilter = all
    ? null
    : resolveOciResourceFilter(
        config,
        resourceFilterRaw
          ? { resource: resourceFilterRaw }
          : instanceFilter
            ? { resource: instanceFilter }
            : {},
      );

  const actions = planOciSync({
    config,
    live,
    prune: true,
    resourceFilter,
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
      extraSections: ociComputeReportExtraSections,
    });
    return;
  }

  const detail = all ? "all managed resources" : resourceFilterRaw ?? instanceFilter ?? "";
  const ok = await confirmTeardown("oci-compute", detail, flags);
  if (!ok) {
    log("teardown cancelled");
    process.exitCode = 0;
    return;
  }

  const results = await applyOciPlan({
    client,
    config,
    live,
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
    extraSections: ociComputeReportExtraSections,
  });
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
