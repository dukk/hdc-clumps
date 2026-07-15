#!/usr/bin/env node
/**
 * Discord query: diff Developer applications vs config (JSON on stdout).
 *
 * Usage: hdc run infrastructure discord query --
 *   [--app <id>] [--import] [--yes] [--require-vault] [--no-derive]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  collectDiscordState,
  fetchLiveApplicationsForImport,
} from "hdc/package/discord-collect.mjs";
import { normalizeDiscordConfig, CLUMP_CONFIG_EXAMPLE } from "hdc/package/discord-config.mjs";
import { importDiscordToConfig } from "hdc/package/discord-import.mjs";
import { createDiscordVaultAccess } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[discord] ${line}\n`);
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
  const appId = flagGet(flags, "app");
  const doImport = flags.import === "1";
  const yes = flags.yes === "1";
  const requireVault = flags["require-vault"] === "1";
  const noDerive = flags["no-derive"] === "1";

  if (doImport) {
    log("import: will merge live application metadata into config.json for apps with bot tokens.");
  }

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    bootstrapFromExample: doImport,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  let config = normalizeDiscordConfig(cfgRaw);
  const vault = createDiscordVaultAccess();

  /** @type {{ application_count: number; config_rel: string } | null} */
  let importResult = null;

  if (doImport) {
    const importRows = await fetchLiveApplicationsForImport({ config, vault, log });
    if (!importRows.length) {
      log("import: no applications fetched (check bot tokens in vault or .env)");
    } else if (!yes) {
      const ok = await confirm(
        `Merge live metadata for ${importRows.length} application(s) into config? [y/N] `
      );
      if (!ok) {
        errout.write("[discord] Aborted: import not confirmed (use --yes to skip prompt).\n");
        process.exitCode = 1;
        return;
      }
    }
    if (importRows.length) {
      const written = importDiscordToConfig({ clumpRoot, importRows, log });
      importResult = {
        application_count: written.application_count,
        config_rel: written.configRel,
      };
      const reloaded = loadClumpConfigFromClumpRoot(clumpRoot, {
        exampleRel: CLUMP_CONFIG_EXAMPLE,
        log: () => {},
      });
      config = normalizeDiscordConfig(reloaded.data);
      log(`import complete: ${written.configRel}`);
    }
  }

  const state = await collectDiscordState({
    config,
    vault,
    appFilterId: appId,
    noDerive,
    requireVault,
    warn: (msg) => log(`warning: ${msg}`),
    log,
  });

  const ok =
    !state.has_drift && !state.vault_incomplete && !state.fetch_errors;

  const payload = {
    ok,
    verb: "query",
    package: "discord",
    config_source: source,
    applications: state.applications,
    has_drift: state.has_drift,
    vault_incomplete: state.vault_incomplete,
    fetch_errors: state.fetch_errors,
    app_id_filter: appId ?? null,
    import: importResult,
    collected_at: new Date().toISOString(),
    summary:
      "Discord Developer application snapshot per configured bot token. Use --import --yes to bootstrap hdc-private config.",
  };

  if (state.has_drift) {
    log("warning: live applications differ from config (run maintain for managed apps)");
  }
  if (state.vault_incomplete) {
    log("warning: one or more bot_token_vault_key values are missing");
  }
  if (state.fetch_errors) {
    log("warning: one or more live API fetches failed");
  }
  log(`done: ${state.applications.length} configured application(s)`);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!ok && !doImport) process.exitCode = 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
