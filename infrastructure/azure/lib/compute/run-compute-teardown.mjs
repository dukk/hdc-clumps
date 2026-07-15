import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import {
  createOperationReportContext,
  recordStep,
  runOperationReportTail,
  setOutcome,
  setStdoutPayload,
} from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { confirmTeardown, teardownDryRun } from "../../../../services/ollama/lib/teardown-confirm.mjs";
import { estimateAzureDeploymentCost } from "./azure-cost-estimate.mjs";
import { resolveAzureComputeDeployments } from "./azure-compute-config.mjs";
import {
  createAzureComputeRunContext,
  CLUMP_CONFIG_EXAMPLE,
} from "./azure-compute-run-context.mjs";
import { azureComputeReportExtraSections } from "./azure-compute-report.mjs";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[azure] compute: ${line}\n`);
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string[]} opts.argv
 * @param {Record<string, string>} opts.flags
 * @param {string} opts.verb
 */
export async function runAzureComputeTeardown(opts) {
  const { clumpRoot, argv, flags, verb } = opts;

  const reportCtx = createOperationReportContext({
    clumpId: "azure",
    clumpTitle: "Azure (compute)",
    verb,
    argv,
    manifestNextSteps: ["Remove inventory system sidecar if the workload is retired."],
  });

  const { data: cfgRaw } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });

  const { config, client } = await createAzureComputeRunContext(cfgRaw);
  const deployments = resolveAzureComputeDeployments(config, flags);

  /** @type {object[]} */
  const results = [];
  let overallOk = true;

  for (const deployment of deployments) {
    const detail = `${deployment.mode} ${deployment.azure.resource_name} (${deployment.azure.resource_group})`;
    const cost_estimate = await estimateAzureDeploymentCost(deployment);
    const confirmed = await confirmTeardown(deployment.systemId, detail, flags);
    if (!confirmed) {
      results.push({
        ok: true,
        skipped: true,
        system_id: deployment.systemId,
        cost_estimate,
        message: teardownDryRun(flags) ? "dry-run" : "not confirmed",
      });
      continue;
    }
    if (teardownDryRun(flags)) {
      results.push({ ok: true, dry_run: true, system_id: deployment.systemId, cost_estimate });
      continue;
    }
    try {
      const out = await client.deleteDeployment(deployment);
      recordStep(reportCtx, {
        id: `teardown-${deployment.id}`,
        title: `Teardown ${deployment.systemId}`,
        ran: true,
        ok: true,
      });
      results.push({ ok: true, system_id: deployment.systemId, cost_estimate, ...out });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      overallOk = false;
      results.push({ ok: false, system_id: deployment.systemId, error: msg });
    }
  }

  setOutcome(reportCtx, { ok: overallOk, dryRun: reportCtx.dryRun, exitCode: overallOk ? 0 : 1 });
  setStdoutPayload(reportCtx, { section: "compute", results });
  await runOperationReportTail({
    ctx: reportCtx,
    clumpRoot,
    repoRoot: repoRoot(),
    extraSections: azureComputeReportExtraSections,
  });

  console.log(JSON.stringify({ ok: overallOk, section: "compute", results }, null, 2));
  process.exitCode = overallOk ? 0 : 1;
}
