#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { resolveOciResourceFilter } from "hdc/package/oci-config.mjs";
import { collectOciLiveState } from "hdc/package/oci-collect.mjs";
import { planOciSync } from "hdc/package/oci-plan.mjs";
import { estimatePlanCost } from "hdc/package/oci-cost-estimate.mjs";
import { createOciComputeRunContext, CLUMP_CONFIG_EXAMPLE } from "hdc/package/oci-run-context.mjs";

const clumpRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function log(line) {
  errout.write(`[oci-compute] query: ${line}\n`);
}

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;
  const resourceFilterRaw = flagGet(flags, "resource");

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, client } = await createOciComputeRunContext(cfgRaw);
  const resourceFilter = resourceFilterRaw
    ? resolveOciResourceFilter(config, { resource: resourceFilterRaw })
    : null;

  const liveState = live ? await collectOciLiveState(client, config) : null;
  const actions = liveState
    ? planOciSync({ config, live: liveState, resourceFilter })
    : [];
  const cost_estimate = estimatePlanCost(actions);

  const payload = {
    ok: true,
    region: config.region,
    compartment_id: config.compartment_id,
    configured: {
      vcns: config.vcns.length,
      subnets: config.subnets.length,
      network_security_groups: config.network_security_groups.length,
      instances: config.instances.length,
      container_instances: config.container_instances.length,
    },
    cost_estimate,
    plan_summary: actions.map((a) => ({
      kind: a.kind,
      resource_id: a.resource_id,
      action: a.action,
    })),
    ...(liveState
      ? {
          live: {
            vcns: liveState.vcns.length,
            subnets: liveState.subnets.length,
            network_security_groups: liveState.network_security_groups.length,
            instances: liveState.instances.length,
            container_instances: liveState.container_instances.length,
          },
        }
      : {}),
  };

  log(`summarized config (${live ? "with live state" : "config only"})`);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
