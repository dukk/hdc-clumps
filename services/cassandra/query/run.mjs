#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Query Cassandra cluster health on configured nodes.
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import {
  cassandraGlobalSettings,
  normalizeCassandraConfig,
  resolveCassandraDeployments,
} from "hdc/package/deployments.mjs";
import { queryCassandraActive, queryNodetoolStatus } from "hdc/package/cassandra-query-remote.mjs";
import { createConfigureExec } from "hdc/package/cassandra-configure.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/cassandra/config.example.json";
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
function tryCfg() {
  return tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
}

const target = basename(dirname(here));
const verb = basename(here);

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Cassandra health check (JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const normalized = normalizeCassandraConfig(cfg);
  const deployments = resolveCassandraDeployments(cfg, flags);
  const global = cassandraGlobalSettings(normalized, deployments);

  /** @type {Record<string, unknown>[]} */
  const nodes = [];

  for (const d of deployments) {
    const ssh = isObject(d.configure) && isObject(d.configure.ssh) ? d.configure.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" ? ssh.host : d.listenIp;
    errout.write(`[hdc] ${target} ${verb}: checking ${d.systemId} at ${user}@${host} …\n`);

    const exec = createConfigureExec("ssh", { user, host });
    const service = queryCassandraActive(exec);
    const nodetool = queryNodetoolStatus(exec);
    const selfNode = nodetool.nodes.find(
      (n) => n.address === d.listenIp || n.address === host || n.address.startsWith(d.listenIp),
    );
    nodes.push({
      system_id: d.systemId,
      seed: d.seed,
      host,
      service,
      nodetool,
      self_state: selfNode?.state ?? null,
      ok: service.active && selfNode?.state === "UN",
    });
  }

  const ok = nodes.length > 0 && nodes.every((n) => n.ok);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        target,
        verb,
        cluster_name: global.clusterName,
        seed_ips: global.seedIps,
        nodes,
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

