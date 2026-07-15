#!/usr/bin/env node
/**
 * Query Valkey Cluster health on configured nodes.
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import {
  clusterEndpointsFromDeployments,
  normalizeValkeyConfig,
  valkeyGlobalSettings,
  resolveValkeyDeployments,
  sshTargetFromDeployment,
} from "hdc/package/deployments.mjs";
import { queryClusterInfo, queryValkeyPing, runClusterCheck } from "hdc/package/valkey-query-remote.mjs";
import { createConfigureExec } from "hdc/package/valkey-configure.mjs";
import { createValkeyVaultAccess } from "hdc/package/vault-deps.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/valkey/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}
function readCfg() {
  return ensurePackageConfig().data;
}

const target = basename(dirname(here));
const verb = basename(here);

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Valkey Cluster health (JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));

  let normalized;
  let deployments;
  try {
    normalized = normalizeValkeyConfig(cfg);
    deployments = resolveValkeyDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const global = valkeyGlobalSettings(normalized);
  const vault = createValkeyVaultAccess();
  await vault.unlock({});
  const password = String(
    await vault.getSecret(global.passwordVaultKey, {
      promptLabel: `vault secret ${global.passwordVaultKey}`,
    }),
  ).trim();
  if (!password) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "missing Valkey password" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, unknown>[]} */
  const nodes = [];

  for (const deployment of deployments) {
    const { user, host } = sshTargetFromDeployment(deployment);
    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} at ${user}@${host} …\n`);

    const exec = createConfigureExec("ssh", { user, host });
    const ping = queryValkeyPing(exec, global.port, password);
    const cluster = queryClusterInfo(exec, global.port, password);
    nodes.push({
      system_id: deployment.systemId,
      host,
      ping,
      cluster,
      ok: ping.ok && cluster.ok,
    });
  }

  /** @type {Record<string, unknown> | null} */
  let clusterCheck = null;
  if (deployments.length === global.minMasters && nodes.every((n) => n.ok)) {
    const endpoints = clusterEndpointsFromDeployments(deployments, global);
    const first = endpoints[0];
    const exec = createConfigureExec("ssh", { user: first.user, host: first.host });
    clusterCheck = runClusterCheck(exec, first.host, first.port, password);
  }

  const nodesOk = nodes.length > 0 && nodes.every((n) => n.ok);
  const slotsOk = nodes.every(
    (n) =>
      typeof n.cluster === "object" &&
      n.cluster !== null &&
      /** @type {{ cluster_slots_assigned?: number }} */ (n.cluster).cluster_slots_assigned === 16384,
  );
  const clusterOk = clusterCheck === null || clusterCheck.ok;
  const ok = nodesOk && slotsOk && clusterOk;

  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        target,
        verb,
        nodes,
        cluster_check: clusterCheck,
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
