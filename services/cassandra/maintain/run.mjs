#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Re-apply Cassandra config; optional rolling restart.
 *
 * Usage: hdc run service cassandra maintain -- [--rolling-restart] [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import {
  cassandraGlobalSettings,
  normalizeCassandraConfig,
  resolveCassandraDeployments,
} from "hdc/package/deployments.mjs";
import {
  configureCassandra,
  createConfigureExec,
  rollingRestartNode,
  waitForCassandraReady,
} from "hdc/package/cassandra-configure.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
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

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Cassandra config sync (stderr log; JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const rolling = flagGet(flags, "rolling-restart") !== undefined;
  const normalized = normalizeCassandraConfig(cfg);
  const deployments = resolveCassandraDeployments(cfg, flags);
  const global = cassandraGlobalSettings(normalized, deployments);
  const log = provisionLogFromConsole(console);

  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const d of deployments) {
    const ssh = isObject(d.configure) && isObject(d.configure.ssh) ? d.configure.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" ? ssh.host : d.listenIp;
    errout.write(`[hdc] ${target} ${verb}: ${d.systemId} at ${user}@${host} …\n`);
    try {
      const exec = createConfigureExec("ssh", { user, host });
      const rack = d.rack || global.rack;
      if (rolling) {
        rollingRestartNode({ exec, log });
      } else {
        configureCassandra({
          exec,
          log,
          clusterName: global.clusterName,
          seedIps: global.seedIps,
          listenIp: d.listenIp || host,
          datacenter: global.datacenter,
          rack,
          version: global.version,
          memoryMb: d.memoryMb || global.defaultMemoryMb,
          passwordAuthEnabled: global.passwordAuthEnabled,
          skipInstall: true,
        });
      }
      const baseline = await ensureGuestLinuxBaseline({ exec, log, flags, vaultAccess, deployment, proxmoxPackageRoot: proxmoxRoot });
      const ready = await waitForCassandraReady({
        exec,
        listenIp: d.listenIp || host,
        onProgress: (m) => errout.write(`[hdc] ${target} ${verb}: ${m}\n`),
      });
      results.push({
        system_id: d.systemId,
        ok: ready.ok && clamav.ok,
        rolling_restart: rolling,
        ready,
        ...guestBaselineResultFields(baseline),
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      results.push({ system_id: d.systemId, ok: false, message: msg });
    }
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  const payload = {
    ok,
    target,
    verb,
    rolling_restart: rolling,
    results,
    generated_at: new Date().toISOString(),
  };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});

