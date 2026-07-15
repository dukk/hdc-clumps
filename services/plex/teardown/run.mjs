#!/usr/bin/env node
/**
 * Teardown Plex: stop Synology PlexMediaServer package (does not uninstall).
 *
 * Usage: hdc run service plex teardown -- [--instance a | --system-id plex-a]
 *        hdc run service plex teardown -- [--dry-run] [--yes]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { normalizePlexConfig, resolvePlexDeployments } from "hdc/package/deployments.mjs";
import { teardownPlexOnSynology } from "hdc/package/plex-synology.mjs";
import {
  confirmTeardown,
  teardownConfirmed,
  teardownDryRun,
} from "../../ollama/lib/teardown-confirm.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/plex/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const root = repoRoot();

function readCfg() {
  return ensurePackageConfig().data;
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: stop Plex package on Synology (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const dryRun = teardownDryRun(flags);

  let toTeardown;
  try {
    normalizePlexConfig(cfg);
    toTeardown = resolvePlexDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  for (const deployment of toTeardown) {
    if (dryRun) continue;
    const detail = "stop PlexMediaServer via synopkg (package stays installed)";
    let proceed = teardownConfirmed(flags);
    if (!proceed) {
      proceed = await confirmTeardown(deployment.systemId, detail, flags);
    }
    if (!proceed) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, target, verb, message: "teardown cancelled" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const deployment of toTeardown) {
    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} …\n`);
    if (dryRun) {
      results.push({
        ok: true,
        system_id: deployment.systemId,
        dry_run: true,
        message: "would stop PlexMediaServer via synopkg stop",
      });
      continue;
    }
    try {
      const result = await teardownPlexOnSynology(deployment, {
        log: (line) => errout.write(`${line}\n`),
      });
      results.push({ system_id: deployment.systemId, ...result });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok !== false);
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
