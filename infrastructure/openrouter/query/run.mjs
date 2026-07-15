#!/usr/bin/env node
/**
 * OpenRouter query: diff credits and API keys vs config (JSON on stdout).
 *
 * Usage: hdc run infrastructure openrouter query --
 *   [--import] [--yes] [--key-id <id>]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createOpenrouterClient } from "hdc/package/openrouter-api.mjs";
import { normalizeOpenrouterConfig } from "hdc/package/openrouter-config.mjs";
import {
  collectOpenrouterState,
  fetchInferenceStatsForConfig,
  fetchLiveOpenrouterState,
} from "hdc/package/openrouter-collect.mjs";
import { importOpenrouterToConfig, liveStateToApiKeys } from "hdc/package/openrouter-import.mjs";
import {
  createOpenrouterVaultAccess,
  resolveOpenrouterApiKey,
} from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/openrouter/config.example.json";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[openrouter] ${line}\n`);
}

/**
 * @param {string} question
 */
async function confirm(question) {
  const rl = createInterface({ input, output: errout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

async function main() {
  log(`${verb}: starting`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const keyId = flagGet(flags, "key-id");
  const doImport = flags.import === "1";
  const yes = flags.yes === "1";

  if (doImport) {
    log("import: will replace api_keys[] in config.json from live API.");
  }

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    bootstrapFromExample: doImport,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  let config = normalizeOpenrouterConfig(cfgRaw);
  const vault = createOpenrouterVaultAccess();
  const managementKey = await resolveOpenrouterApiKey(vault, config.managementVaultKey);
  log(`management API key loaded (${config.managementVaultKey})`);

  const api = createOpenrouterClient({
    apiKey: managementKey,
    apiBaseUrl: config.apiBase,
  });

  /** @type {{ api_key_count: number; config_rel: string } | null} */
  let importResult = null;

  const live = await fetchLiveOpenrouterState(api, log);
  const inferenceStats = await fetchInferenceStatsForConfig(config, api, vault, log);

  if (doImport) {
    if (!yes) {
      const ok = await confirm(
        `Replace api_keys[] with ${live.keys.length} key(s) from live account? [y/N] `
      );
      if (!ok) {
        errout.write("[openrouter] Aborted: import not confirmed (use --yes to skip prompt).\n");
        process.exitCode = 1;
        return;
      }
    }
    const written = importOpenrouterToConfig({ clumpRoot, live, log });
    importResult = {
      api_key_count: written.api_key_count,
      config_rel: written.configRel,
    };

    const existingByHash = new Map(
      config.apiKeys
        .filter((k) => k.openrouter_hash)
        .map((k) => [k.openrouter_hash, k])
    );
    const existingByName = new Map(config.apiKeys.map((k) => [k.name, k]));
    const api_keys = liveStateToApiKeys(live, existingByHash, existingByName);
    config = normalizeOpenrouterConfig({
      ...cfgRaw,
      api_keys,
    });
    log(`import complete: ${written.configRel}`);
  }

  const state = collectOpenrouterState({
    config,
    live,
    inferenceStats,
    keyIdFilter: keyId,
  });

  const ok = !state.has_drift;

  const payload = {
    ok,
    verb: "query",
    package: "openrouter",
    config_source: source,
    credits: state.credits,
    api_keys: state.api_keys,
    extra_in_live: state.extra_in_live,
    has_drift: state.has_drift,
    live_key_count: state.live_key_count,
    configured_key_count: state.configured_key_count,
    key_id_filter: state.key_id_filter,
    import: importResult,
    collected_at: new Date().toISOString(),
    summary:
      "OpenRouter account snapshot (credits + API keys). Use --import --yes to bootstrap hdc-private config.",
  };

  if (state.has_drift) {
    log("warning: live account differs from config (run maintain for managed keys)");
  }
  if (state.credits.low_balance) {
    log(
      `warning: credits remaining ($${state.credits.remaining_usd.toFixed(2)}) below low_balance_usd (${state.credits.low_balance_usd})`
    );
  }
  log(
    `done: ${state.live_key_count} live key(s), ${state.configured_key_count} configured, remaining credits $${state.credits.remaining_usd.toFixed(2)}`
  );

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (state.has_drift && !doImport) process.exitCode = 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
