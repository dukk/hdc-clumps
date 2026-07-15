#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { estimateGcpDeploymentCost } from "hdc/package/gcp-cost-estimate.mjs";
import { resolveGcpComputeDeployments } from "hdc/package/gcp-compute-config.mjs";
import {
  createGcpComputeRunContext,
  CLUMP_CONFIG_EXAMPLE,
} from "hdc/package/gcp-compute-run-context.mjs";

const clumpRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function log(line) {
  errout.write(`[gcp-compute] query: ${line}\n`);
}

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, client } = await createGcpComputeRunContext(cfgRaw);
  const deployments = resolveGcpComputeDeployments(config, flags);

  /** @type {object[]} */
  const results = [];
  for (const deployment of deployments) {
    const cost_estimate = await estimateGcpDeploymentCost(deployment);
    /** @type {Record<string, unknown>} */
    const row = {
      id: deployment.id,
      system_id: deployment.systemId,
      mode: deployment.mode,
      resource_name: deployment.gcp.resource_name,
      region: deployment.gcp.region,
      zone: deployment.gcp.zone,
      cost_estimate,
    };
    if (live) row.live = await client.getLiveDeployment(deployment);
    results.push(row);
  }

  log(`summarized ${results.length} deployment(s)`);
  console.log(JSON.stringify({ ok: true, deployments: results }, null, 2));
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
