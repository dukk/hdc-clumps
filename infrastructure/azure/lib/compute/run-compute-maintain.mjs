import { stderr as errout } from "node:process";

import { confirmDeployCost } from "hdc/package/deploy-cost-confirm.mjs";
import { toAwsCostEstimate } from "hdc/package/cloud-cost-format.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import {
  createOperationReportContext,
  recordStep,
  runOperationReportTail,
  setOutcome,
  setStdoutPayload,
} from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
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
export async function runAzureComputeMaintain(opts) {
  const { clumpRoot, argv, flags, verb } = opts;

  const reportCtx = createOperationReportContext({
    clumpId: "azure",
    clumpTitle: "Azure (compute)",
    verb,
    argv,
    manifestNextSteps: [
      "Run `hdc run infrastructure azure query -- --section compute --live`.",
    ],
  });

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, client } = await createAzureComputeRunContext(cfgRaw);
  const deployments = resolveAzureComputeDeployments(config, flags);

  /** @type {object[]} */
  const results = [];
  let overallOk = true;

  for (const deployment of deployments) {
    const costEstimate = await estimateAzureDeploymentCost(deployment);
    const needsConfirm = deployment.mode === "azure-aci";
    let proceed = true;
    if (needsConfirm && !reportCtx.dryRun) {
      const confirm = await confirmDeployCost({
        estimate: toAwsCostEstimate(costEstimate, deployment.systemId),
        flags,
        log,
      });
      proceed = confirm.proceed;
    }
    if (!proceed) {
      results.push({
        ok: true,
        skipped: true,
        system_id: deployment.systemId,
        cost_estimate: costEstimate,
      });
      continue;
    }
    if (reportCtx.dryRun) {
      results.push({
        ok: true,
        dry_run: true,
        system_id: deployment.systemId,
        cost_estimate: costEstimate,
      });
      recordStep(reportCtx, {
        id: `maintain-${deployment.id}`,
        title: `Maintain ${deployment.systemId}`,
        ran: false,
        skipReason: "dry-run",
        ok: true,
      });
      continue;
    }
    try {
      const out = await client.maintainDeployment(deployment);
      recordStep(reportCtx, {
        id: `maintain-${deployment.id}`,
        title: `Maintain ${deployment.systemId}`,
        ran: true,
        ok: true,
      });
      results.push({
        ok: true,
        system_id: deployment.systemId,
        cost_estimate: costEstimate,
        ...out,
      });
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
