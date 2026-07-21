#!/usr/bin/env node
/**
 * Discord maintain: PATCH managed Developer applications.
 *
 * Usage: hdc run infrastructure discord maintain --
 *   [--app <id>] [--dry-run] [--no-derive] [--skip-icon] [--no-report] [--report <path>]
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
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { printDeveloperPortalChecklist } from "hdc/package/discord-checklist.mjs";
import { collectDiscordState, fetchLiveApplication } from "hdc/package/discord-collect.mjs";
import { createDiscordClient } from "hdc/package/discord-api.mjs";
import { normalizeDiscordConfig, CLUMP_CONFIG_EXAMPLE } from "hdc/package/discord-config.mjs";
import { DISCORD_COMPACT_ARRAY_KEYS } from "hdc/package/discord-import.mjs";
import { syncConfiguredAppIcons } from "hdc/package/discord-icon.mjs";
import { applyAppSync, planAppSync } from "hdc/package/discord-sync.mjs";
import { createDiscordVaultAccess, resolveDiscordBotToken } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure discord query --` to verify application drift.",
  "Enable privileged Gateway Intents in the Discord Developer Portal when checklist items are listed.",
  "After token rotation, update vault secrets and re-run query.",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[discord] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const appFilter = flagGet(flags, "app");
  const noDerive = flags["no-derive"] === "1";
  const skipIcon = flags["skip-icon"] === "1";

  const reportCtx = createOperationReportContext({
    clumpId: "discord",
    clumpTitle: "Discord applications",
    verb,
    argv,
    manifestNextSteps: MANIFEST_NEXT_STEPS,
  });

  log(`${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}`);

  const { data: cfgRaw, source, resolved } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  let config = normalizeDiscordConfig(cfgRaw);
  const vault = createDiscordVaultAccess();
  const hdcRoot = repoRoot();

  let entries = config.applications.filter((a) => a.managed);
  if (appFilter) {
    const one = config.applicationsById.get(appFilter);
    if (!one) throw new Error(`Application not in config applications[]: ${appFilter}`);
    if (!one.managed) throw new Error(`Application is not managed: ${appFilter}`);
    entries = [one];
  }

  if (!entries.length) {
    pushWarning(reportCtx, "No managed applications[] entries to maintain.");
  }

  let overallOk = true;
  let configDirty = false;
  const nextApplications = Array.isArray(cfgRaw.applications) ? [...cfgRaw.applications] : [];

  for (const entry of entries) {
    let live = null;
    try {
      const token = await resolveDiscordBotToken(vault, entry.bot_token_vault_key);
      const api = createDiscordClient({ botToken: token, apiBaseUrl: config.apiBase });
      live = await fetchLiveApplication(api, log);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`key ${entry.id}: live fetch failed: ${msg}`);
      recordStep(reportCtx, {
        id: `app-${entry.id}`,
        title: `Maintain: ${entry.display_name}`,
        ran: false,
        skipReason: "live fetch failed",
        ok: false,
        notes: [msg],
      });
      overallOk = false;
      continue;
    }

    const plan = planAppSync({
      configApp: entry,
      live,
      noDerive,
      warn: (msg) => log(`warning: ${msg}`),
    });
    log(`app ${entry.id}: plan action=${plan.action}`);

    let applyResult = { ok: true, action: plan.action };
    if (plan.action === "update") {
      const token = await resolveDiscordBotToken(vault, entry.bot_token_vault_key);
      const api = createDiscordClient({ botToken: token, apiBaseUrl: config.apiBase });
      applyResult = await applyAppSync(api, plan, {
        dryRun: reportCtx.dryRun,
        log,
      });
    } else {
      applyResult = await applyAppSync(
        createDiscordClient({ botToken: "dry-run", apiBaseUrl: config.apiBase }),
        plan,
        { dryRun: reportCtx.dryRun, log }
      );
    }

    recordStep(reportCtx, {
      id: `app-${entry.id}`,
      title: `Maintain: ${entry.display_name}`,
      ran: plan.action === "update",
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

  if (!skipIcon && entries.length) {
    const iconSync = await syncConfiguredAppIcons({
      apps: entries,
      hdcRoot,
      configApplications: nextApplications,
      dryRun: reportCtx.dryRun,
      log,
      createApiForApp: async (app) => {
        const token = await resolveDiscordBotToken(vault, app.bot_token_vault_key);
        return createDiscordClient({ botToken: token, apiBaseUrl: config.apiBase });
      },
    });
    for (const iconResult of iconSync.results) {
      recordStep(reportCtx, {
        id: `icon-${iconResult.id}`,
        title: `Icon: ${iconResult.id}`,
        ran: iconResult.action === "upload",
        skipReason:
          iconResult.action === "unchanged"
            ? "unchanged"
            : iconResult.action === "missing_token"
              ? "bot token unavailable"
              : undefined,
        ok: iconResult.ok !== false,
        notes: iconResult.error ? [iconResult.error] : [],
      });
      if (iconResult.ok === false) overallOk = false;
    }
    if (iconSync.configDirty && !reportCtx.dryRun) {
      configDirty = true;
      nextApplications.splice(0, nextApplications.length, ...iconSync.nextApplications);
    }
  }

  if (configDirty && !reportCtx.dryRun) {
    writeResolvedRepoJson(resolved, { ...cfgRaw, applications: nextApplications }, {
      compactArrayKeys: DISCORD_COMPACT_ARRAY_KEYS,
    });
    log(`wrote icon.applied_sha256 updates to ${resolved.rel}`);
    config = normalizeDiscordConfig({ ...cfgRaw, applications: nextApplications });
  }

  const snapshot = await collectDiscordState({
    config,
    vault,
    appFilterId: appFilter,
    noDerive,
    requireVault: false,
    resolveOpts: { hdcRoot },
    warn: (msg) => log(`warning: ${msg}`),
    log,
  });

  if (snapshot.has_drift) {
    pushWarning(reportCtx, "Drift remains after maintain (extra redirect URIs are report-only in v1).");
  }

  printDeveloperPortalChecklist({
    developerPortalUrl: config.developerPortalUrl,
    applications: appFilter
      ? config.applications.filter((a) => a.id === appFilter)
      : config.applications,
    log,
  });

  setOutcome(reportCtx, { ok: overallOk, dryRun: reportCtx.dryRun, exitCode: overallOk ? 0 : 1 });
  setStdoutPayload(reportCtx, {
    config_source: source,
    applications: snapshot.applications,
    has_drift: snapshot.has_drift,
  });

  await runOperationReportTail({
    ctx: reportCtx,
    clumpRoot,
    repoRoot: hdcRoot,
    log,
  });

  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  process.exitCode = overallOk ? 0 : 1;
}

main().catch(async (e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
