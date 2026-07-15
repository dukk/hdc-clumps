#!/usr/bin/env node
/**
 * OpenRouter maintain: create or update managed inference API keys.
 *
 * Usage: hdc run infrastructure openrouter maintain --
 *   [--key-id <id>] [--dry-run] [--prune] [--no-report] [--report <path>]
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
import { createOpenrouterClient } from "hdc/package/openrouter-api.mjs";
import { normalizeOpenrouterConfig } from "hdc/package/openrouter-config.mjs";
import { collectOpenrouterState, fetchLiveOpenrouterState } from "hdc/package/openrouter-collect.mjs";
import { findLiveKeyForEntry } from "hdc/package/openrouter-config.mjs";
import {
  applyKeyDelete,
  applyKeySync,
  liveKeysByEntry,
  planKeySync,
} from "hdc/package/openrouter-sync.mjs";
import {
  createOpenrouterVaultAccess,
  resolveOpenrouterApiKey,
} from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/openrouter/config.example.json";

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure openrouter query --` to verify credits and API key drift.",
  "If a new inference key was created, redeploy or maintain consumer services (e.g. hermes) to pick up the vault secret.",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[openrouter] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const keyId = flagGet(flags, "key-id");
  const prune = flags.prune === "1";

  const reportCtx = createOperationReportContext({
    clumpId: "openrouter",
    clumpTitle: "OpenRouter",
    verb,
    argv,
    manifestNextSteps: MANIFEST_NEXT_STEPS,
    extraFlags: { prune },
  });

  log(`${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}${prune ? " (prune)" : ""}`);

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const config = normalizeOpenrouterConfig(cfgRaw);
  const vault = createOpenrouterVaultAccess();
  const managementKey = await resolveOpenrouterApiKey(vault, config.managementVaultKey);
  log(`management API key loaded (${config.managementVaultKey})`);

  const api = createOpenrouterClient({
    apiKey: managementKey,
    apiBaseUrl: config.apiBase,
  });

  let live = await fetchLiveOpenrouterState(api, log);

  let entries = config.apiKeys.filter((k) => k.managed);
  if (keyId) {
    const one = config.keysById.get(keyId);
    if (!one) throw new Error(`API key id not in config api_keys[]: ${keyId}`);
    if (!one.managed) throw new Error(`API key is not managed: ${keyId}`);
    entries = [one];
  }

  if (!entries.length) {
    pushWarning(reportCtx, "No managed api_keys[] entries to maintain.");
  }

  let overallOk = true;
  const liveMap = liveKeysByEntry(entries, live.keys);

  for (const entry of entries) {
    const liveRow = liveMap.get(entry.id) ?? findLiveKeyForEntry(entry, live.keys);
    const plan = planKeySync({
      entry,
      live: liveRow,
      defaults: config.defaults,
    });
    log(`key ${entry.name}: plan action=${plan.action}`);

    const applyResult = await applyKeySync(api, plan, { vault, entry }, {
      dryRun: reportCtx.dryRun,
      log,
    });

    recordStep(reportCtx, {
      id: `key-${entry.id}`,
      title: `Maintain: ${entry.name}`,
      ran: plan.action !== "skip" && plan.action !== "unchanged",
      skipReason:
        plan.action === "skip"
          ? plan.reason
          : plan.action === "unchanged"
            ? "unchanged"
            : undefined,
      ok: applyResult.ok,
      notes: applyResult.error ? [applyResult.error] : [],
    });

    if (!applyResult.ok) overallOk = false;
  }

  if (prune) {
    const configHashes = new Set(
      config.apiKeys.filter((k) => k.openrouter_hash).map((k) => k.openrouter_hash)
    );
    const configNames = new Set(config.apiKeys.map((k) => k.name));
    for (const row of live.keys) {
      if (!row.hash) continue;
      if (configHashes.has(row.hash) || (row.name && configNames.has(row.name))) continue;

      log(`prune: deleting live key not in config: ${row.name} (${row.hash})`);
      const delResult = await applyKeyDelete(api, { hash: row.hash, name: row.name }, {
        dryRun: reportCtx.dryRun,
        log,
      });
      recordStep(reportCtx, {
        id: `prune-${row.hash}`,
        title: `Prune: ${row.name}`,
        ran: true,
        ok: delResult.ok,
        notes: delResult.error ? [delResult.error] : [],
      });
      if (!delResult.ok) overallOk = false;
    }
  }

  live = await fetchLiveOpenrouterState(api, log);

  const snapshot = collectOpenrouterState({
    config,
    live,
    keyIdFilter: keyId,
  });

  if (snapshot.credits.low_balance) {
    pushWarning(
      reportCtx,
      `Credits remaining ($${snapshot.credits.remaining_usd.toFixed(2)}) below low_balance_usd (${snapshot.credits.low_balance_usd})`
    );
    overallOk = false;
  }

  setOutcome(reportCtx, { ok: overallOk, dryRun: reportCtx.dryRun, exitCode: overallOk ? 0 : 1 });
  setStdoutPayload(reportCtx, {
    config_source: source,
    credits: snapshot.credits,
    api_keys: snapshot.api_keys,
    extra_in_live: snapshot.extra_in_live,
    has_drift: snapshot.has_drift,
  });

  await runOperationReportTail({
    ctx: reportCtx,
    clumpRoot,
    repoRoot: repoRoot(),
  });

  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  process.exitCode = overallOk ? 0 : 1;
}

main().catch(async (e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
