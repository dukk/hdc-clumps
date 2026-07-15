#!/usr/bin/env node
/**
 * AWS query: diff config vs live resources; optional --import --yes.
 *
 * Usage: hdc run infrastructure aws query --
 *   [--import] [--yes] [--require-vault] [--no-report] [--report <path>]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  createOperationReportContext,
  runOperationReportTail,
  setOutcome,
  setStdoutPayload,
} from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { collectAwsLiveState, diffAwsState } from "hdc/package/aws-collect.mjs";
import { buildImportConfig, writeAwsConfigImport } from "hdc/package/aws-import.mjs";
import { awsReportExtraSections } from "hdc/package/aws-report.mjs";
import { createAwsRunContext, CLUMP_CONFIG_EXAMPLE } from "hdc/package/aws-run-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

/**
 * @param {string} line
 */
function log(line) {
  stderr.write(`[aws] ${line}\n`);
}

/**
 * @param {string} question
 */
async function confirm(question) {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    const raw = (await rl.question(question)).trim().toLowerCase();
    return raw === "y" || raw === "yes";
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const doImport = flagGet(flags, "import") !== undefined;
  const yes = flagGet(flags, "yes", "y") !== undefined;

  const reportCtx = createOperationReportContext({
    clumpId: "aws",
    clumpTitle: "AWS infrastructure",
    verb,
    argv,
  });

  log(`${verb}: starting`);

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => stderr.write(line),
  });
  log(`config loaded (${source})`);

  const { config, client } = await createAwsRunContext(cfgRaw);
  log(`region: ${config.region}`);

  const liveByKind = await collectAwsLiveState(client);
  const diffs = diffAwsState(config, liveByKind);

  const missing = diffs.filter((d) => d.status === "missing").length;
  const extra = diffs.filter((d) => d.status === "extra").length;
  log(`diff: ${missing} missing, ${extra} extra, ${diffs.length - missing - extra} present`);

  if (doImport) {
    if (!yes) {
      const ok = await confirm("Write AWS config snapshot to hdc-private? [y/N] ");
      if (!ok) {
        log("import aborted");
        setStdoutPayload(reportCtx, { ok: false, aborted: true, diffs });
        setOutcome(reportCtx, { ok: false, exitCode: 1 });
        await runOperationReportTail({
          clumpRoot,
          reportCtx,
          repoRoot: repoRoot(),
          payload: reportCtx.stdoutPayload ?? {},
          ok: false,
          log,
          extraSections: awsReportExtraSections,
        });
        process.exitCode = 1;
        return;
      }
    }
    const imported = buildImportConfig(liveByKind, config);
    const written = writeAwsConfigImport(repoRoot(), imported);
    log(`import wrote ${written}`);
  }

  const payload = {
    ok: true,
    region: config.region,
    diffs,
    counts: {
      missing,
      extra,
      present: diffs.length - missing - extra,
    },
    imported: doImport && yes,
  };

  setStdoutPayload(reportCtx, payload);
  setOutcome(reportCtx, { ok: true, exitCode: 0 });
  console.log(JSON.stringify(payload, null, 2));
  await runOperationReportTail({
    clumpRoot,
    reportCtx,
    repoRoot: repoRoot(),
    payload,
    ok: true,
    log,
    extraSections: awsReportExtraSections,
  });
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
