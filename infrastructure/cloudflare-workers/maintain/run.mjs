#!/usr/bin/env node
/**
 * Cloudflare Workers maintain: sync routes and secrets; optional code redeploy.
 *
 * Usage: hdc run infrastructure cloudflare-workers maintain --
 *   [--worker <id>] [--pages <id>] [--redeploy] [--prune]
 *   [--skip-routes] [--skip-secrets] [--dry-run] [--no-report] [--report <path>]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  createOperationReportContext,
  recordStep,
  runOperationReportTail,
  setOutcome,
  setStdoutPayload,
  pushWarning,
} from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { workerPassesFilter, pagesPassesFilter } from "hdc/package/workers-config.mjs";
import { collectWorkersState } from "hdc/package/workers-collect.mjs";
import { deployWorker, deployPages, listWorkerRoutesByZone } from "hdc/package/workers-deploy.mjs";
import { applyRouteSync, applySecretSync, planRouteSync, planSecretSync } from "hdc/package/workers-sync.mjs";
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
  "Run `hdc run infrastructure cloudflare-workers query --` to verify drift after maintain.",
  "Use `deploy` to upload worker code; maintain syncs routes/secrets unless `--redeploy`.",
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
  const redeploy = flags.redeploy === "1";
  const prune = flags.prune === "1";
  const skipRoutes = flags["skip-routes"] === "1";
  const skipSecrets = flags["skip-secrets"] === "1";

  const reportCtx = createOperationReportContext({
    clumpId: "cloudflare-workers",
    clumpTitle: "Cloudflare Workers and Pages",
    verb,
    argv,
    manifestNextSteps: MANIFEST_NEXT_STEPS,
    extraFlags: { redeploy, prune, skipRoutes, skipSecrets },
  });

  log(
    `${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}${redeploy ? " (redeploy)" : ""}${prune ? " (prune)" : ""}`
  );

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, token, workersApi, dnsApi, vault } = await createWorkersRunContext(cfgRaw);

  if (redeploy) {
    checkWranglerAvailable(config.wranglerBinary);
  }

  const workersToRun = config.workers.filter((w) => workerPassesFilter(w, workerFilter));
  const pagesToRun = config.pages.filter((p) => pagesPassesFilter(p, pagesFilter));

  let overallOk = true;

  for (const worker of workersToRun) {
    let workerOk = true;
    /** @type {string[]} */
    const notes = [];

    if (redeploy) {
      const vaultSecrets = await readWorkerVaultSecrets(vault, worker);
      const dep = await deployWorker({
        config,
        worker,
        clumpRoot,
        token,
        workersApi,
        vaultSecrets,
        dryRun: reportCtx.dryRun,
        log,
      });
      notes.push(dep.ok ? `redeploy ${worker.script_name}` : String(dep.error));
      if (!dep.ok) workerOk = false;
    }

    if (!skipRoutes && worker.routes.length) {
      const zoneRoutes = await listWorkerRoutesByZone(workersApi, dnsApi, worker, config);
      for (const z of zoneRoutes) {
        if (!z.zone_id) {
          pushWarning(reportCtx, `Zone not in account: ${z.zone_name} (worker ${worker.id})`);
          workerOk = false;
          continue;
        }
        const desiredForZone = worker.routes.filter((r) => r.zone_name === z.zone_name);
        const plan = planRouteSync(desiredForZone, z.routes, worker.script_name, prune);
        log(
          `worker ${worker.id} zone ${z.zone_name}: routes create=${plan.summary.create} delete=${plan.summary.delete}`
        );
        const apply = await applyRouteSync(workersApi, z.zone_id, plan, {
          dryRun: reportCtx.dryRun,
          log,
        });
        notes.push(
          `${z.zone_name}: create ${plan.summary.create}, delete ${plan.summary.delete}`,
          ...apply.results.filter((r) => !r.ok).map((r) => `${r.key}: ${r.error}`)
        );
        if (!apply.ok) workerOk = false;
      }
    }

    if (!skipSecrets && worker.secrets.length) {
      let liveSecrets = [];
      try {
        liveSecrets = await workersApi.listWorkerSecrets(worker.script_name);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found|10007|8000007/i.test(msg)) {
          pushWarning(reportCtx, `Worker script not deployed yet: ${worker.script_name}`);
          notes.push("secrets skipped: script missing");
        } else {
          notes.push(`secrets: ${msg}`);
          workerOk = false;
        }
        liveSecrets = [];
      }
      if (!liveSecrets.length && notes.at(-1)?.includes("script missing")) {
        recordStep(reportCtx, {
          id: `worker-${worker.id}`,
          title: `Maintain worker: ${worker.id}`,
          ran: true,
          ok: workerOk,
          notes,
        });
        if (!workerOk) overallOk = false;
        continue;
      }
      const secretPlan = planSecretSync(worker.secrets, liveSecrets);
      const vaultSecrets = await readWorkerVaultSecrets(vault, worker);
      const secretApply = await applySecretSync(
        workersApi,
        worker.script_name,
        secretPlan,
        vaultSecrets,
        { dryRun: reportCtx.dryRun, log }
      );
      notes.push(`secrets put ${secretPlan.summary.put}`);
      notes.push(
        ...secretApply.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`)
      );
      if (!secretApply.ok) workerOk = false;
    }

    recordStep(reportCtx, {
      id: `worker-${worker.id}`,
      title: `Maintain worker: ${worker.id}`,
      ran: true,
      ok: workerOk,
      notes,
    });
    if (!workerOk) overallOk = false;
  }

  if (redeploy) {
    for (const page of pagesToRun) {
      const dep = await deployPages({
        config,
        page,
        clumpRoot,
        token,
        workersApi,
        dryRun: reportCtx.dryRun,
        log,
      });
      recordStep(reportCtx, {
        id: `pages-${page.id}`,
        title: `Redeploy Pages: ${page.id}`,
        ran: true,
        ok: dep.ok,
        notes: dep.error ? [String(dep.error)] : [`project ${page.project_name}`],
      });
      if (!dep.ok) overallOk = false;
    }
  }

  const snapshot = await collectWorkersState(config, workersApi, dnsApi);
  const stdoutPayload = {
    ok: overallOk,
    verb: "maintain",
    package: "cloudflare-workers",
    dry_run: reportCtx.dryRun,
    redeploy,
    missing_worker_scripts: snapshot.missing_worker_scripts,
    missing_pages_projects: snapshot.missing_pages_projects,
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

  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  process.exitCode = overallOk ? 0 : 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
