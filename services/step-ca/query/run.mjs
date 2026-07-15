#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Query step-ca service health on configured nodes.
 *
 * Usage: hdc run service step-ca query -- [--instance a | --system-id vm-step-ca-a] [--live]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { createConfigureExec } from "hdc/package/step-ca-configure.mjs";
import {
  normalizeStepCaConfig,
  resolveStepCaDeployments,
  stepCaGlobalSettings,
} from "hdc/package/deployments.mjs";
import {
  queryStepCaHealth,
  queryStepCaInitialized,
  queryStepCaServiceActive,
} from "hdc/package/step-ca-query-remote.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/step-ca/config.example.json";
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

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: step-ca health check (JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;

  let deployments;
  let global;
  try {
    const normalized = normalizeStepCaConfig(cfg);
    global = stepCaGlobalSettings(normalized);
    deployments = resolveStepCaDeployments(cfg, flags);
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

    errout.write(`[hdc] ${target} ${verb}: ${d.systemId} at ${user}@${host} …\n`);

    /** @type {Record<string, unknown>} */
    const node = {
      system_id: d.systemId,
      role: d.role,
      host,
      listen_address: global.listenAddress,
      dns_names: global.dnsNames,
      enable_acme: global.enableAcme,
      step_path: global.stepPath,
      ok: true,
    };

    if (live) {
      const exec = createConfigureExec("ssh", { user, host });
      const service = queryStepCaServiceActive(exec);
      const health = queryStepCaHealth(exec, global.listenAddress);
      const initialized = queryStepCaInitialized(exec, global.stepPath);
      node.service = service;
      node.health = health;
      node.ca = initialized;
      node.ok = service.active && health.ok && initialized.config_present;
    }

    nodes.push(node);
  }

  const ok = nodes.length > 0 && nodes.every((n) => n.ok === true);
  process.stdout.write(
    `${JSON.stringify({ ok, target, verb, live, nodes, generated_at: new Date().toISOString() }, null, 2)}\n`,
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
