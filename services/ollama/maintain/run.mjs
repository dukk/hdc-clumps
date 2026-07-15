#!/usr/bin/env node
/**
 * Maintain Ollama: sync configured models (pull / optional prune), guest Linux baseline.
 *
 * Usage: hdc run service ollama maintain -- [--instance a | --system-id vm-ollama-a]
 *        hdc run service ollama maintain -- [--prune] [--dry-run] [--skip-models] [--skip-clamav]
 *        [--skip-resources] [--no-reboot] [--reboot]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import {
  loadClumpConfigFromClumpRoot,
  tryLoadClumpConfigFromClumpRoot,
} from "hdc/package/clump-run-config.mjs";
import { resolveOllamaDeployments } from "hdc/package/deployments.mjs";
import { createOllamaExec, syncOllamaModels } from "hdc/package/ollama-models.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/ollama/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: CLUMP_CONFIG_EXAMPLE,
    });
  }
  return _pkgConfig;
}

const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
const ubuntuRoot = join(root, "clumps", "infrastructure", "ubuntu");

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolveOllamaDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 */
async function maintainOne(deployment, flags, vaultAccess) {
  const { systemId, mode, ollama } = deployment;
  const skipModels = flagGet(flags, "skip-models", "skip_models") !== undefined;
  const prune = flagGet(flags, "prune") !== undefined;
  const log = provisionLogFromConsole(console);

  /** @type {Record<string, unknown>} */
  const result = { ok: true, system_id: systemId, mode };

  let exec = null;
  try {
    if (mode === "proxmox-lxc" || mode === "proxmox-qemu" || mode === "ubuntu-docker") {
      exec = createOllamaExec(deployment, proxmoxRoot, ubuntuRoot);
    }
  } catch (e) {
    return { ok: false, system_id: systemId, message: String(/** @type {Error} */ (e).message || e) };
  }

  if (exec && (mode === "proxmox-lxc" || mode === "proxmox-qemu")) {
    errout.write(`[hdc] ${target} ${verb}: guest baseline on ${systemId} …\n`);
    const baseline = await ensureGuestLinuxBaseline({
      exec,
      log,
      flags,
      vaultAccess,
      deployment,
      proxmoxPackageRoot: proxmoxRoot,
    });
    result.guest_resources = baseline.guest_resources;
    result.admin_user = baseline.admin_user;
    result.clamav = baseline.clamav;
    if (!baseline.ok) {
      return { ...result, ok: false, message: "guest baseline failed" };
    }
  }

  if (!skipModels && exec) {
    const models = ollama?.models ?? [];
    if (!models.length) {
      errout.write(`[hdc] ${target} ${verb}: ${systemId} — no ollama.models configured, skipping sync.\n`);
      result.models = { skipped: true, message: "no models configured" };
    } else {
      errout.write(
        `[hdc] ${target} ${verb}: ${systemId} — syncing ${models.length} model(s)${prune ? " (prune enabled)" : ""} …\n`,
      );
      const sync = await syncOllamaModels(exec, models, flags, { prune });
      result.models = sync;
      if (!sync.ok) {
        return {
          ...result,
          ok: false,
          message: sync.message ?? sync.error ?? "model sync failed",
        };
      }
    }
  } else if (skipModels) {
    result.models = { skipped: true, message: "--skip-models" };
  } else if (mode !== "proxmox-lxc" && mode !== "proxmox-qemu" && mode !== "ubuntu-docker") {
    return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  }

  return result;
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Ollama model sync and guest baseline (stderr log; JSON on stdout).\n`);

  const cfgLoad = tryLoadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
  });
  if (!cfgLoad) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  _pkgConfig = cfgLoad;
  errout.write(`[hdc] ${target} ${verb}: config ${cfgLoad.source}\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});

  let deployments;
  try {
    deployments = resolveOllamaDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (deployments.length > 1) {
    errout.write(`[hdc] ${target} ${verb}: maintaining ${deployments.length} instance(s) …\n`);
  }

  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainOne(deployment, flags, vaultAccess));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok);
  const payload = { ok, target, verb, count: results.length, results };
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
