#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Re-apply Kafka server.properties and rolling-restart brokers.
 *
 * Usage: hdc run service kafka maintain -- [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import {
  kafkaGlobalSettings,
  normalizeKafkaConfig,
  resolveAllKafkaDeployments,
  resolveKafkaDeployments,
} from "hdc/package/deployments.mjs";
import { configureKafkaNode, createConfigureExec } from "hdc/package/kafka-configure.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/kafka/config.example.json";
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

/**
 * @param {ReturnType<typeof resolveKafkaDeployments>[number]} deployment
 */
function sshFromDeployment(deployment) {
  const cfg = isObject(deployment.configure) ? deployment.configure : {};
  const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  const host = deployment.sshHost;
  if (!host) throw new Error(`${deployment.systemId}: configure.ssh.host required`);
  return { user, host };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Kafka config sync and rolling restart (stderr log; JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  let normalized;
  let global;
  let allDeployments;
  let deployments;
  try {
    normalized = normalizeKafkaConfig(cfg);
    global = kafkaGlobalSettings(normalized);
    allDeployments = resolveAllKafkaDeployments(cfg);
    deployments = resolveKafkaDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const log = provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    const ssh = sshFromDeployment(deployment);
    errout.write(
      `[hdc] ${target} ${verb}: ${deployment.systemId} node ${deployment.nodeId} ${ssh.user}@${ssh.host} …\n`,
    );
    try {
      const exec = createConfigureExec("ssh", ssh);
      const configure = await configureKafkaNode({
        exec,
        allDeployments,
        deployment,
        global,
        restart: true,
      });
      const baseline = await ensureGuestLinuxBaseline({ exec, log, flags, vaultAccess, deployment, proxmoxPackageRoot: proxmoxRoot });
      results.push({
        system_id: deployment.systemId,
        node_id: deployment.nodeId,
        host: ssh.host,
        ok: configure.ok && clamav.ok,
        configure,
        ...guestBaselineResultFields(baseline),
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({
        system_id: deployment.systemId,
        node_id: deployment.nodeId,
        ok: false,
        message: msg,
      });
    }
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  const payload = {
    ok,
    target,
    verb,
    cluster_id: global.clusterId,
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

