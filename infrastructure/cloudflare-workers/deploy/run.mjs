#!/usr/bin/env node
/**
 * Cloudflare Workers and Pages deploy via wrangler.
 *
 * Usage: hdc run infrastructure cloudflare-workers deploy --
 *   [--worker <id>] [--pages <id>] [--dry-run] [--skip-build] [--skip-npm-install]
 *   [--no-report] [--report <path>]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout, stdout as out } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  createOperationReportContext,
  recordStep,
  runOperationReportTail,
  setOutcome,
  setStdoutPayload,
} from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { workerPassesFilter, pagesPassesFilter } from "hdc/package/workers-config.mjs";
import { deployWorker, deployPages } from "hdc/package/workers-deploy.mjs";
import {
  createWorkersRunContext,
  readWorkerVaultSecrets,
  CLUMP_CONFIG_EXAMPLE,
} from "hdc/package/workers-run-context.mjs";
import { checkWranglerAvailable } from "hdc/package/workers-wrangler.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure cloudflare-workers query --` to verify live state.",
  "Bootstrap: `query -- --import --yes` to seed workers[] and pages[] from the account.",
  "Ensure wrangler is installed (`npm install -g wrangler` or per-project devDependency).",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[cloudflare-workers] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const workerFilter = flagGet(flags, "worker");
  const pagesFilter = flagGet(flags, "pages");
  const skipBuild = flags["skip-build"] === "1";
  const skipNpmInstall = flags["skip-npm-install"] === "1";

  const reportCtx = createOperationReportContext({
    clumpId: "cloudflare-workers",
    clumpTitle: "Cloudflare Workers and Pages",
    verb,
    argv,
    manifestNextSteps: MANIFEST_NEXT_STEPS,
    extraFlags: { skipBuild, skipNpmInstall },
  });

  log(
    `${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}${workerFilter ? ` worker=${workerFilter}` : ""}${pagesFilter ? ` pages=${pagesFilter}` : ""}`
  );

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, token, workersApi, vault } = await createWorkersRunContext(cfgRaw);
  const wranglerVersion = checkWranglerAvailable(config.wranglerBinary);
  log(`wrangler ${wranglerVersion}`);

  const workersToDeploy = config.workers.filter((w) => workerPassesFilter(w, workerFilter));
  const pagesToDeploy = config.pages.filter((p) => pagesPassesFilter(p, pagesFilter));

  if (!workersToDeploy.length && !pagesToDeploy.length) {
    throw new Error("No managed workers or pages entries match the current filters");
  }

  /** @type {Record<string, unknown>[]} */
  const workerResults = [];
  /** @type {Record<string, unknown>[]} */
  const pagesResults = [];
  let overallOk = true;

  for (const worker of workersToDeploy) {
    const vaultSecrets = await readWorkerVaultSecrets(vault, worker);
    const result = await deployWorker({
      config,
      worker,
      clumpRoot,
      token,
      workersApi,
      vaultSecrets,
      dryRun: reportCtx.dryRun,
      skipNpmInstall,
      log,
    });
    workerResults.push(result);
    recordStep(reportCtx, {
      id: `worker-${worker.id}`,
      title: `Deploy worker: ${worker.id}`,
      ran: true,
      ok: result.ok,
      notes: result.error ? [String(result.error)] : [`script ${worker.script_name}`],
    });
    if (!result.ok) overallOk = false;
  }

  for (const page of pagesToDeploy) {
    const result = await deployPages({
      config,
      page,
      clumpRoot,
      token,
      workersApi,
      dryRun: reportCtx.dryRun,
      skipBuild,
      skipNpmInstall,
      log,
    });
    pagesResults.push(result);
    recordStep(reportCtx, {
      id: `pages-${page.id}`,
      title: `Deploy Pages: ${page.id}`,
      ran: true,
      ok: result.ok,
      notes: result.error ? [String(result.error)] : [`project ${page.project_name}`],
    });
    if (!result.ok) overallOk = false;
  }

  const stdoutPayload = {
    ok: overallOk,
    verb: "deploy",
    package: "cloudflare-workers",
    dry_run: reportCtx.dryRun,
    workers: workerResults,
    pages: pagesResults,
  };

  setOutcome(reportCtx, { ok: overallOk, dryRun: reportCtx.dryRun, exitCode: overallOk ? 0 : 1 });
  setStdoutPayload(reportCtx, stdoutPayload);

  await runOperationReportTail({
    reportCtx,
    clumpRoot,
    repoRoot: repoRoot(),
    ok: overallOk,
    payload: stdoutPayload,
    log,
  });

  out.write(`${JSON.stringify(stdoutPayload, null, 2)}\n`);
  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  process.exitCode = overallOk ? 0 : 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
