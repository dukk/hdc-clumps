#!/usr/bin/env node
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Maintain Redis Cluster nodes: re-apply config, optional apt upgrade, cluster check.
 *
 * Usage: hdc run service redis maintain -- [--instance a|b|c] [--skip-apt]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  clusterEndpointsFromDeployments,
  normalizeRedisConfig,
  redisGlobalSettings,
  resolveRedisDeployments,
  sshTargetFromDeployment,
} from "hdc/package/deployments.mjs";
import { configureRedis, createConfigureExec } from "hdc/package/redis-configure.mjs";
import { aptUpgradeRedisCommand } from "hdc/package/redis-install.mjs";
import { runClusterCheck } from "hdc/package/redis-cluster.mjs";
import { createRedisVaultAccess } from "hdc/package/vault-deps.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/redis/config.example.json";
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

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 100)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Redis Cluster maintain (stderr log; JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const skipApt = flagGet(flags, "skip-apt") !== undefined;

  let normalized;
  let deployments;
  try {
    normalized = normalizeRedisConfig(cfg);
    deployments = resolveRedisDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const global = redisGlobalSettings(normalized);
  const vault = createRedisVaultAccess();
  await vault.unlock({});
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const password = String(
    await vault.getSecret(global.passwordVaultKey, {
      promptLabel: `vault secret ${global.passwordVaultKey}`,
    }),
  ).trim();
  if (!password) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "missing Redis password" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const log = provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const nodes = [];

  for (const deployment of deployments) {
    const { user, host } = sshTargetFromDeployment(deployment);
    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} at ${user}@${host} …\n`);
    try {
      const exec = createConfigureExec("ssh", { user, host });
      if (!skipApt) {
        runChecked(exec, aptUpgradeRedisCommand(), log);
      }
      const configure = configureRedis({
        exec,
        log,
        announceIp: host,
        port: global.port,
        password,
        maxmemory: global.maxmemory,
        maxmemoryPolicy: global.maxmemoryPolicy,
        runInstall: false,
      });
      const baseline = await ensureGuestLinuxBaseline({ exec, log, flags, vaultAccess, deployment, proxmoxPackageRoot: proxmoxRoot });
      nodes.push({
        system_id: deployment.systemId,
        host,
        ok: baseline.ok,
        configure,
        apt_upgrade: !skipApt,
        ...guestBaselineResultFields(baseline),
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      nodes.push({ system_id: deployment.systemId, host, ok: false, message: msg });
    }
  }

  /** @type {Record<string, unknown> | null} */
  let clusterCheck = null;
  if (deployments.length === global.minMasters && nodes.every((n) => n.ok)) {
    const endpoints = clusterEndpointsFromDeployments(deployments, global);
    const first = endpoints[0];
    errout.write(`[hdc] ${target} ${verb}: cluster check via ${first.host}:${first.port} …\n`);
    const exec = createConfigureExec("ssh", { user: first.user, host: first.host });
    clusterCheck = runClusterCheck(exec, first.host, first.port, password);
  }

  const nodesOk = nodes.length > 0 && nodes.every((n) => n.ok);
  const clusterOk = clusterCheck === null || clusterCheck.ok;
  const ok = nodesOk && clusterOk;
  const payload = {
    ok,
    target,
    verb,
    nodes,
    cluster_check: clusterCheck,
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

