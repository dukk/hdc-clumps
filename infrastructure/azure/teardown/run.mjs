#!/usr/bin/env node
/**
 * Azure teardown: compute resources only.
 *
 * Usage: hdc run infrastructure azure teardown -- --section compute
 *   [--instance a] [--yes] [--dry-run]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { resolveAzureSection } from "hdc/package/section.mjs";
import { runAzureComputeTeardown } from "hdc/package/compute/run-compute-teardown.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[azure] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  let section;
  try {
    section = resolveAzureSection(flags, { allowAll: false, defaultSection: "compute" });
  } catch {
    section = "compute";
  }
  if (section !== "compute") {
    throw new Error(
      "teardown only applies to Azure compute resources; use --section compute (Entra app registrations are not torn down by hdc)"
    );
  }
  await runAzureComputeTeardown({ clumpRoot, argv, flags, verb });
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
