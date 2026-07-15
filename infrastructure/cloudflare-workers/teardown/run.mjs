#!/usr/bin/env node
/**
 * Cloudflare Workers and Pages teardown.
 *
 * Usage: hdc run infrastructure cloudflare-workers teardown --
 *   [--worker <id>] [--pages <id>] [--yes] [--dry-run] [--no-report] [--report <path>]
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
import { resolveWorkerProjectDir } from "hdc/package/workers-config.mjs";
import {
  buildPagesProjectDeleteArgv,
  buildWorkerDeleteArgv,
  checkWranglerAvailable,
  runWrangler,
} from "hdc/package/workers-wrangler.mjs";
import { createWorkersRunContext, CLUMP_CONFIG_EXAMPLE } from "hdc/package/workers-run-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure cloudflare-workers query --` to confirm resources were removed.",
  "Local project trees under hdc-private are not deleted by teardown.",
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
  const confirmed = flags.yes === "1";

  const reportCtx = createOperationReportContext({
    clumpId: "cloudflare-workers",
    clumpTitle: "Cloudflare Workers and Pages",
    verb,
    argv,
    manifestNextSteps: MANIFEST_NEXT_STEPS,
    extraFlags: { confirmed },
  });

  if (!confirmed && !reportCtx.dryRun) {
    throw new Error("teardown requires --yes to delete live Workers scripts or Pages projects");
  }

  log(`${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}${confirmed ? " (confirmed)" : ""}`);

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, token } = await createWorkersRunContext(cfgRaw);
  checkWranglerAvailable(config.wranglerBinary);

  const wranglerEnv = {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
  };

  const workersToRemove = config.workers.filter((w) => workerPassesFilter(w, workerFilter));
  const pagesToRemove = config.pages.filter((p) => pagesPassesFilter(p, pagesFilter));

  if (!workersToRemove.length && !pagesToRemove.length) {
    throw new Error("No managed workers or pages entries match the current filters");
  }

  /** @type {Record<string, unknown>[]} */
  const workerResults = [];
  /** @type {Record<string, unknown>[]} */
  const pagesResults = [];
  let overallOk = true;

  for (const worker of workersToRemove) {
    const projectPath = resolveWorkerProjectDir(clumpRoot, worker.project_dir);
    const args = buildWorkerDeleteArgv(worker.script_name);
    log(`worker ${worker.id}: wrangler ${args.join(" ")}`);
    if (reportCtx.dryRun) {
      workerResults.push({ ok: true, id: worker.id, script_name: worker.script_name, dry_run: true });
      recordStep(reportCtx, {
        id: `worker-${worker.id}`,
        title: `Teardown worker: ${worker.id}`,
        ran: false,
        skipReason: "dry-run",
        ok: true,
      });
      continue;
    }
    const wr = runWrangler({
      binary: config.wranglerBinary,
      args,
      cwd: projectPath,
      env: wranglerEnv,
    });
    const ok = wr.ok;
    workerResults.push({
      ok,
      id: worker.id,
      script_name: worker.script_name,
      error: ok ? undefined : (wr.stderr || wr.stdout || "").trim().slice(0, 300),
    });
    recordStep(reportCtx, {
      id: `worker-${worker.id}`,
      title: `Teardown worker: ${worker.id}`,
      ran: true,
      ok,
      notes: ok ? [`deleted ${worker.script_name}`] : [String(workerResults.at(-1)?.error)],
    });
    if (!ok) overallOk = false;
  }

  for (const page of pagesToRemove) {
    const projectPath = resolveWorkerProjectDir(clumpRoot, page.project_dir);
    const args = buildPagesProjectDeleteArgv(page.project_name);
    log(`pages ${page.id}: wrangler ${args.join(" ")}`);
    if (reportCtx.dryRun) {
      pagesResults.push({ ok: true, id: page.id, project_name: page.project_name, dry_run: true });
      recordStep(reportCtx, {
        id: `pages-${page.id}`,
        title: `Teardown Pages: ${page.id}`,
        ran: false,
        skipReason: "dry-run",
        ok: true,
      });
      continue;
    }
    const wr = runWrangler({
      binary: config.wranglerBinary,
      args,
      cwd: projectPath,
      env: wranglerEnv,
    });
    const ok = wr.ok;
    pagesResults.push({
      ok,
      id: page.id,
      project_name: page.project_name,
      error: ok ? undefined : (wr.stderr || wr.stdout || "").trim().slice(0, 300),
    });
    recordStep(reportCtx, {
      id: `pages-${page.id}`,
      title: `Teardown Pages: ${page.id}`,
      ran: true,
      ok,
      notes: ok ? [`deleted ${page.project_name}`] : [String(pagesResults.at(-1)?.error)],
    });
    if (!ok) overallOk = false;
  }

  const stdoutPayload = {
    ok: overallOk,
    verb: "teardown",
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
