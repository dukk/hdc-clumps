#!/usr/bin/env node
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { confirmDeployCost } from "hdc/package/deploy-cost-confirm.mjs";
import { toAwsCostEstimate } from "hdc/package/cloud-cost-format.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import {
  createOperationReportContext,
  recordStep,
  runOperationReportTail,
  setOutcome,
  setStdoutPayload,
} from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { estimateGcpDeploymentCost } from "hdc/package/gcp-cost-estimate.mjs";
import { resolveGcpComputeDeployments } from "hdc/package/gcp-compute-config.mjs";
import {
  createGcpComputeRunContext,
  CLUMP_CONFIG_EXAMPLE,
} from "hdc/package/gcp-compute-run-context.mjs";
import { gcpComputeReportExtraSections } from "hdc/package/gcp-compute-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

function log(line) {
  errout.write(`[gcp-compute] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);

  const reportCtx = createOperationReportContext({
    clumpId: "gcp-compute",
    clumpTitle: "GCP compute",
    verb,
    argv,
    manifestNextSteps: ["Run `hdc run infrastructure gcp-compute query -- --live`."],
  });

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, client } = await createGcpComputeRunContext(cfgRaw);
  const deployments = resolveGcpComputeDeployments(config, flags);

  /** @type {object[]} */
  const results = [];
  let overallOk = true;

  for (const deployment of deployments) {
    const costEstimate = await estimateGcpDeploymentCost(deployment);
    const needsConfirm = deployment.mode === "gcp-cloud-run";
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
      results.push({ ok: true, skipped: true, system_id: deployment.systemId, cost_estimate: costEstimate });
      continue;
    }
    if (reportCtx.dryRun) {
      results.push({ ok: true, dry_run: true, system_id: deployment.systemId, cost_estimate: costEstimate });
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
      results.push({ ok: true, system_id: deployment.systemId, cost_estimate: costEstimate, ...out });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      overallOk = false;
      results.push({ ok: false, system_id: deployment.systemId, error: msg });
    }
  }

  setOutcome(reportCtx, { ok: overallOk, dryRun: reportCtx.dryRun, exitCode: overallOk ? 0 : 1 });
  setStdoutPayload(reportCtx, { results });
  await runOperationReportTail({
    ctx: reportCtx,
    clumpRoot,
    repoRoot: repoRoot(),
    extraSections: gcpComputeReportExtraSections,
  });

  console.log(JSON.stringify({ ok: overallOk, results }, null, 2));
  process.exitCode = overallOk ? 0 : 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
