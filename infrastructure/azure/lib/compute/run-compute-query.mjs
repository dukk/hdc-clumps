import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { estimateAzureDeploymentCost } from "./azure-cost-estimate.mjs";
import { resolveAzureComputeDeployments } from "./azure-compute-config.mjs";
import {
  createAzureComputeRunContext,
  CLUMP_CONFIG_EXAMPLE,
} from "./azure-compute-run-context.mjs";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[azure] compute: ${line}\n`);
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {Record<string, string>} opts.flags
 * @param {boolean} [opts.printJson]
 * @returns {Promise<object>}
 */
export async function runAzureComputeQuery(opts) {
  const { clumpRoot, flags } = opts;
  const printJson = opts.printJson !== false;
  const live = flagGet(flags, "live") !== undefined;

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  /** @type {Awaited<ReturnType<typeof createAzureComputeRunContext>> | null} */
  let ctx = null;
  try {
    ctx = await createAzureComputeRunContext(cfgRaw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`skipped compute query: ${msg}`);
    const payload = {
      ok: true,
      section: "compute",
      package: "azure",
      skipped: true,
      skip_reason: msg,
      config_source: source,
      deployments: [],
      collected_at: new Date().toISOString(),
    };
    if (printJson) console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  const { config, client } = ctx;
  if (!config.deployments.length) {
    const payload = {
      ok: true,
      section: "compute",
      package: "azure",
      skipped: true,
      skip_reason: "no compute deployments in config",
      config_source: source,
      deployments: [],
      collected_at: new Date().toISOString(),
    };
    if (printJson) console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  const deployments = resolveAzureComputeDeployments(config, flags);

  /** @type {object[]} */
  const results = [];
  for (const deployment of deployments) {
    const cost_estimate = await estimateAzureDeploymentCost(deployment);
    /** @type {Record<string, unknown>} */
    const row = {
      id: deployment.id,
      system_id: deployment.systemId,
      mode: deployment.mode,
      resource_name: deployment.azure.resource_name,
      resource_group: deployment.azure.resource_group,
      location: deployment.azure.location,
      cost_estimate,
    };
    if (live) {
      row.live = await client.getLiveDeployment(deployment);
    }
    results.push(row);
  }

  log(`summarized ${results.length} deployment(s)${live ? " (live)" : ""}`);
  const payload = {
    ok: true,
    section: "compute",
    package: "azure",
    config_source: source,
    deployments: results,
    collected_at: new Date().toISOString(),
  };
  if (printJson) {
    console.log(JSON.stringify(payload, null, 2));
  }
  return payload;
}
