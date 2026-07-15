#!/usr/bin/env node
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();

errout.write(`[hdc] ${target} ${verb}: stub — add maintenance tasks.\n`);

const ok = true;
const payload = {
  ok,
  target,
  verb,
  stub: true,
  message: "stub — add maintenance tasks",
  generated_at: new Date().toISOString(),
};
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
