#!/usr/bin/env node
/**
 * GCP compute deploy: GCE VMs and Cloud Run with cost confirmation.
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { confirmDeployCost } from "hdc/package/deploy-cost-confirm.mjs";
import { toAwsCostEstimate } from "hdc/package/cloud-cost-format.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
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
import { createGcpComputeHostProvisioner } from "hdc/package/gcp-compute-host-provisioner.mjs";
import { promptExistingGcpResourceAction } from "hdc/package/prompt-existing.mjs";
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

/**
 * @param {import("../lib/gcp-compute-config.mjs").NormalizedGcpDeployment} deployment
 */
async function deployOne(deployment, client, creds, flags, reportCtx) {
  const { systemId, mode } = deployment;
  const live = await client.getLiveDeployment(deployment);
  if (live?.exists) {
    const action = await promptExistingGcpResourceAction(
      systemId,
      `${mode} ${deployment.gcp.resource_name}`,
      flags,
    );
    if (action === "skip") {
      recordStep(reportCtx, {
        id: `deploy-${deployment.id}`,
        title: `Deploy ${systemId}`,
        ran: false,
        skipReason: "existing resource",
        ok: true,
      });
      return { ok: true, skipped: true, system_id: systemId, mode, message: "skipped" };
    }
    if (action === "destroy" && !reportCtx.dryRun) {
      await client.deleteDeployment(deployment);
      log(`${systemId}: destroyed existing resource`);
    }
  }

  const costEstimate = await estimateGcpDeploymentCost(deployment);
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
    notes: [
      reportCtx.dryRun ? "dry-run" : confirm.proceed ? "confirmed" : "declined",
    ],
  });

  if (!confirm.proceed) {
    return {
      ok: true,
      skipped: true,
      system_id: systemId,
      mode,
      cost_estimate: costEstimate,
      cost_confirmed: confirm.confirmed,
      message: reportCtx.dryRun ? "dry-run complete" : "declined",
    };
  }

  const provisioner = createGcpComputeHostProvisioner({
    getToken: creds.getToken,
    projectId: creds.projectId,
    deployment,
  });
  const plog = provisionLogFromConsole(console);
  const provision =
    mode === "gcp-vm"
      ? await provisioner.createVm(plog, { name: deployment.gcp.resource_name })
      : await provisioner.createContainer(plog, { name: deployment.gcp.resource_name });

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
    resource_name: deployment.gcp.resource_name,
    region: deployment.gcp.region,
    zone: deployment.gcp.zone,
    cost_estimate: costEstimate,
    cost_confirmed: true,
    ...details,
    message: provision.message,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);

  const reportCtx = createOperationReportContext({
    clumpId: "gcp-compute",
    clumpTitle: "GCP compute",
    verb,
    argv,
    manifestNextSteps: [
      "Run `hdc run infrastructure gcp-compute query -- --live` to verify resources.",
    ],
  });

  log(`${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}`);

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, creds, client } = await createGcpComputeRunContext(cfgRaw);
  log("vault: HDC_GCP_COMPUTE_SERVICE_ACCOUNT_JSON loaded");

  const deployments = resolveGcpComputeDeployments(config, flags);
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
  setStdoutPayload(reportCtx, { results });

  await runOperationReportTail({
    ctx: reportCtx,
    clumpRoot,
    repoRoot: repoRoot(),
    extraSections: gcpComputeReportExtraSections,
  });

  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  console.log(JSON.stringify({ ok: overallOk, results }, null, 2));
  process.exitCode = overallOk ? 0 : 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
