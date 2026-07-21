#!/usr/bin/env node
/**
 * Slack query: diff App Manifest apps vs config (JSON on stdout).
 *
 * Usage: hdc run infrastructure slack query --
 *   [--app <id>] [--import] [--yes] [--no-rotate]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout, stdout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { hdcPrivateRoot } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { collectSlackState } from "hdc/package/slack-collect.mjs";
import { CLUMP_CONFIG_EXAMPLE } from "hdc/package/slack-config.mjs";
import { importSlackToConfig } from "hdc/package/slack-import.mjs";
import {
  createSlackRunContext,
  loadHdcAgentsPublicUrl,
} from "hdc/package/slack-run-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[slack] ${line}\n`);
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
  const appFilter = flagGet(flags, "app");
  const doImport = flags.import === "1";
  const yes = flags.yes === "1";
  const noRotate = flags["no-rotate"] === "1";

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    bootstrapFromExample: doImport,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, api } = await createSlackRunContext(cfgRaw, {
    rotateTokens: !noRotate,
    log,
  });

  const hdcRoot = repoRoot();
  const privateRoot = hdcPrivateRoot(hdcRoot) || "";
  const publicUrl = loadHdcAgentsPublicUrl(privateRoot, hdcRoot);

  /** @type {{ updated: number; config_rel: string } | null} */
  let importResult = null;
  if (doImport) {
    if (!yes) {
      const ok = await confirm(
        "Merge live Slack manifest metadata into config for apps with match.app_id? [y/N] ",
      );
      if (!ok) {
        log("import cancelled");
      } else {
        importResult = await importSlackToConfig({
          clumpRoot,
          config,
          api,
          log,
        });
      }
    } else {
      importResult = await importSlackToConfig({ clumpRoot, config, api, log });
    }
  }

  let apps = config.apps;
  if (appFilter) {
    apps = apps.filter((a) => a.id === appFilter);
    if (!apps.length) throw new Error(`App not in config: ${appFilter}`);
  }

  const state = await collectSlackState({
    config: { ...config, apps, managedApps: apps.filter((a) => a.managed) },
    api,
    resolveOpts: { hdcAgentsPublicUrl: publicUrl, hdcRoot },
    log,
  });

  const payload = {
    ok: state.ok,
    package: "slack",
    verb,
    import: importResult,
    ...state,
  };
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(state.ok ? 0 : 1);
}

main().catch((e) => {
  errout.write(`[slack] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
