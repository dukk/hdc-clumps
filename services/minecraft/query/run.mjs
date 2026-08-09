#!/usr/bin/env node
/**
 * Query Minecraft deployments (config summary + optional live status).
 *
 * Usage: hdc run service minecraft query -- [--instance a]
 *        hdc run service minecraft query -- --live
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listMinecraftDeploymentSummaries,
  normalizeMinecraftConfig,
  resolveMinecraftDeployments,
} from "hdc/package/deployments.mjs";
import { queryMinecraftLive } from "hdc/package/query-status.mjs";
import { tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/minecraft/config.example.json";

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
  });
  const rel = loaded?.path
    ? relative(root, loaded.path).replace(/\\/g, "/")
    : CLUMP_CONFIG_EXAMPLE;
  const cfg = loaded?.ok && isObject(loaded.data) ? loaded.data : null;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded?.ok ? "loaded" : "not loaded"}.\n`);

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;

  if (cfg) {
    try {
      const norm = normalizeMinecraftConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listMinecraftDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveMinecraftDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
      for (const d of selected) {
        try {
          liveResults.push(await queryMinecraftLive(d));
        } catch (e) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            error: String(/** @type {Error} */ (e).message || e),
          });
        }
      }
    }
  }

  const payload = {
    ok: !configError,
    target,
    verb,
    config_path: rel,
    schema_version: schemaVersion,
    config_error: configError,
    deployments,
    live: live ? liveResults : undefined,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = configError ? 1 : 0;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
