#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Query PostgreSQL service health on configured nodes.
 *
 * Usage: hdc run service postgresql query -- [--instance a | --system-id vm-postgres-b]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import {
  normalizePostgresqlConfig,
  resolvePostgresqlDeployments,
} from "hdc/package/deployments.mjs";
import {
  queryPgIsready,
  queryPostgresqlActive,
  queryPostgresqlVersion,
  queryRecoveryStatus,
  queryReplicationLag,
} from "hdc/package/postgresql-query-remote.mjs";
import { createConfigureExec } from "hdc/package/postgresql-configure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/postgresql/config.example.json";
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
  errout.write(`[hdc] ${target} ${verb}: PostgreSQL health check (JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    normalizePostgresqlConfig(cfg);
    deployments = resolvePostgresqlDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, unknown>[]} */
  const nodes = [];

  for (const d of deployments) {
    const ssh = isObject(d.configure) && isObject(d.configure.ssh) ? d.configure.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" ? ssh.host : "";
    if (!host) {
      nodes.push({ system_id: d.systemId, ok: false, message: "missing ssh host" });
      continue;
    }

    errout.write(`[hdc] ${target} ${verb}: checking ${d.systemId} (${d.role}) at ${user}@${host} …\n`);

    const exec = createConfigureExec("ssh", { user, host });
    const service = queryPostgresqlActive(exec);
    const ready = queryPgIsready(exec);
    const version = queryPostgresqlVersion(exec);
    const recovery = queryRecoveryStatus(exec);

    /** @type {Record<string, unknown>} */
    const node = {
      system_id: d.systemId,
      role: d.role,
      host,
      service,
      pg_isready: ready,
      version,
      recovery,
      ok: service.active && ready.ok && version.ok,
    };

    if (d.role === "standby" && recovery.in_recovery) {
      const lag = queryReplicationLag(exec);
      node.replication_lag = lag;
      node.ok = node.ok && lag.ok;
    }

    nodes.push(node);
  }

  const ok = nodes.length > 0 && nodes.every((n) => n.ok);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        target,
        verb,
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

