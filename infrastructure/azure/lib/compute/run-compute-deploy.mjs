import { stderr as errout } from "node:process";

import { confirmDeployCost } from "hdc/package/deploy-cost-confirm.mjs";
import { toAwsCostEstimate } from "hdc/package/cloud-cost-format.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
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
import { createAzureComputeHostProvisioner } from "./azure-compute-host-provisioner.mjs";
import { promptExistingAzureResourceAction } from "./prompt-existing.mjs";
import {
  createAzureComputeRunContext,
  CLUMP_CONFIG_EXAMPLE,
} from "./azure-compute-run-context.mjs";
import { azureComputeReportExtraSections } from "./azure-compute-report.mjs";

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure azure query -- --section compute --live` to verify resources.",
  "Update inventory access IP for cloud VMs after deploy.",
];

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
export async function runAzureComputeDeploy(opts) {
  const { clumpRoot, argv, flags, verb } = opts;

  const reportCtx = createOperationReportContext({
    clumpId: "azure",
    clumpTitle: "Azure (compute)",
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

  const { config, creds, client } = await createAzureComputeRunContext(cfgRaw);
  log("vault: HDC_AZURE_COMPUTE_CLIENT_SECRET loaded");

  const deployments = resolveAzureComputeDeployments(config, flags);
  /** @type {object[]} */
  const results = [];
  let overallOk = true;

  for (const deployment of deployments) {
    log(`deployment ${deployment.id} (${deployment.systemId}, ${deployment.mode})`);
    try {
      const result = await deployOne(deployment, client, creds, flags, reportCtx);
      results.push(result);
      if (result.ok === false) overallOk = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`deployment ${deployment.id} failed: ${msg}`);
      results.push({ ok: false, system_id: deployment.systemId, error: msg });
      overallOk = false;
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

  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  console.log(JSON.stringify({ ok: overallOk, section: "compute", results }, null, 2));
  process.exitCode = overallOk ? 0 : 1;
}

async function deployOne(deployment, client, creds, flags, reportCtx) {
  const { systemId, mode } = deployment;

  const live = await client.getLiveDeployment(deployment);
  if (live?.exists) {
    const action = await promptExistingAzureResourceAction(
      systemId,
      `${mode} ${deployment.azure.resource_name}`,
      flags
    );
    if (action === "skip") {
      recordStep(reportCtx, {
        id: `deploy-${deployment.id}`,
        title: `Deploy ${systemId}`,
        ran: false,
        skipReason: "existing resource",
        ok: true,
        notes: [`action=skip`],
      });
      return {
        ok: true,
        skipped: true,
        system_id: systemId,
        mode,
        message: "resource exists; skipped",
      };
    }
    if (action === "destroy") {
      if (!reportCtx.dryRun) await client.deleteDeployment(deployment);
      log(`${systemId}: destroyed existing ${mode} before redeploy`);
    }
  }

  const costEstimate = await estimateAzureDeploymentCost(deployment);
  const awsEstimate = toAwsCostEstimate(costEstimate, systemId);
  recordStep(reportCtx, {
    id: `estimate-${deployment.id}`,
    title: `Cost estimate: ${systemId}`,
    ran: true,
    ok: !costEstimate.unknown,
    notes: [`monthly_usd=${awsEstimate.total_monthly_usd}`],
  });

  const confirm = await confirmDeployCost({
    estimate: awsEstimate,
    flags,
    log,
  });
  recordStep(reportCtx, {
    id: `confirm-${deployment.id}`,
    title: `Cost confirmation: ${systemId}`,
    ran: true,
    ok: confirm.proceed || reportCtx.dryRun,
    notes: [reportCtx.dryRun ? "dry-run" : confirm.proceed ? "confirmed" : "declined"],
  });

  if (!confirm.proceed) {
    return {
      ok: true,
      skipped: true,
      system_id: systemId,
      mode,
      cost_estimate: costEstimate,
      cost_confirmed: confirm.confirmed,
      message: reportCtx.dryRun ? "dry-run complete" : "deploy declined",
    };
  }

  const provisioner = createAzureComputeHostProvisioner({
    getToken: creds.getToken,
    subscriptionId: creds.subscriptionId,
    deployment,
  });
  const plog = provisionLogFromConsole(console);

  let provision;
  if (mode === "azure-vm") {
    provision = await provisioner.createVm(plog, { name: deployment.azure.resource_name });
  } else {
    provision = await provisioner.createContainer(plog, { name: deployment.azure.resource_name });
  }

  recordStep(reportCtx, {
    id: `provision-${deployment.id}`,
    title: `Provision ${systemId}`,
    ran: true,
    ok: provision.ok,
    notes: [provision.message ?? ""],
  });

  const details = provision.details && typeof provision.details === "object" ? provision.details : {};
  return {
    ok: provision.ok,
    system_id: systemId,
    mode,
    resource_name: deployment.azure.resource_name,
    resource_group: deployment.azure.resource_group,
    location: deployment.azure.location,
    cost_estimate: costEstimate,
    cost_confirmed: true,
    ...details,
    message: provision.message,
  };
}
