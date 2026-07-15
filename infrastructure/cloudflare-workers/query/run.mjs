#!/usr/bin/env node
/**
 * Cloudflare Workers and Pages query (JSON on stdout).
 *
 * Usage: hdc run infrastructure cloudflare-workers query --
 *   [--worker <id>] [--pages <id>] [--import] [--yes]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { collectAllRoutesByScript, collectWorkersState } from "hdc/package/workers-collect.mjs";
import {
  buildImportPagesEntries,
  buildImportWorkersEntries,
  importWorkersToConfig,
} from "hdc/package/workers-import.mjs";
import { createWorkersRunContext, CLUMP_CONFIG_EXAMPLE } from "hdc/package/workers-run-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[cloudflare-workers] ${line}\n`);
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
  const workerFilter = flagGet(flags, "worker");
  const pagesFilter = flagGet(flags, "pages");
  const doImport = flags.import === "1";
  const yes = flags.yes === "1";

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    bootstrapFromExample: doImport,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, workersApi, dnsApi } = await createWorkersRunContext(cfgRaw);
  log("fetching Workers scripts, routes, and Pages projects");

  const snapshot = await collectWorkersState(config, workersApi, dnsApi);

  /** @type {{ config_rel: string; worker_count: number; pages_count: number } | null} */
  let importResult = null;

  if (doImport) {
    const workerCount = snapshot.live_scripts.length;
    const pagesCount = snapshot.live_pages.length;
    if (!yes) {
      const ok = await confirm(
        `Replace workers[] and pages[] with ${workerCount} script(s) and ${pagesCount} Pages project(s)? [y/N] `
      );
      if (!ok) {
        errout.write("[cloudflare-workers] Aborted: import not confirmed (use --yes).\n");
        process.exitCode = 1;
        return;
      }
    }

    const routesByScript = await collectAllRoutesByScript(config, workersApi, dnsApi);

    const workers = buildImportWorkersEntries(snapshot, routesByScript);
    const pages = buildImportPagesEntries(snapshot);
    const written = importWorkersToConfig({ clumpRoot, workers, pages, log });
    importResult = {
      config_rel: written.configRel,
      worker_count: workers.length,
      pages_count: pages.length,
    };
    log(`import complete: ${written.configRel}`);
  }

  const filteredWorkers = workerFilter
    ? snapshot.workers.filter((w) => {
        const cfg = config.workers.find((c) => c.script_name === w.script_name);
        return cfg?.id === workerFilter;
      })
    : snapshot.workers;

  const filteredMissingScripts = workerFilter
    ? snapshot.missing_worker_scripts.filter((n) => {
        const cfg = config.workers.find((c) => c.script_name === n);
        return cfg?.id === workerFilter;
      })
    : snapshot.missing_worker_scripts;

  const filteredMissingPages = pagesFilter
    ? snapshot.missing_pages_projects.filter((n) => {
        const cfg = config.pages.find((c) => c.project_name === n);
        return cfg?.id === pagesFilter;
      })
    : snapshot.missing_pages_projects;

  const ok =
    filteredMissingScripts.length === 0 &&
    filteredMissingPages.length === 0;

  const payload = {
    ok,
    verb: "query",
    package: "cloudflare-workers",
    config_source: source,
    account_id: config.accountId,
    managed_worker_ids: config.workers.filter((w) => w.managed).map((w) => w.id),
    managed_pages_ids: config.pages.filter((p) => p.managed).map((p) => p.id),
    live_script_count: snapshot.live_scripts.length,
    live_pages_count: snapshot.live_pages.length,
    missing_worker_scripts: filteredMissingScripts,
    missing_pages_projects: filteredMissingPages,
    unmanaged_live_scripts: snapshot.unmanaged_live_scripts,
    unmanaged_live_pages: snapshot.unmanaged_live_pages,
    workers: filteredWorkers,
    live_scripts: snapshot.live_scripts.map((s) => s.name),
    live_pages: snapshot.live_pages.map((p) => p.name),
    import: importResult,
    collected_at: new Date().toISOString(),
    summary:
      "Workers and Pages snapshot. Use --import --yes to bootstrap config; deploy uploads code via wrangler; maintain syncs routes and secrets.",
  };

  if (!ok) {
    log(
      `warning: missing live resources — workers: ${filteredMissingScripts.join(", ") || "(none)"}; pages: ${filteredMissingPages.join(", ") || "(none)"}`
    );
  }
  log(`done: ${snapshot.live_scripts.length} script(s), ${snapshot.live_pages.length} Pages project(s) in account`);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
