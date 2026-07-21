#!/usr/bin/env node
/**
 * Slack maintain: update managed app manifests; print portal checklist.
 *
 * Usage: hdc run infrastructure slack maintain --
 *   [--app <id>] [--dry-run] [--no-rotate] [--skip-icon]
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
  pushWarning,
} from "hdc/package/operation-report.mjs";
import { hdcPrivateRoot } from "hdc/cli/lib/private-repo.mjs";
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { collectSlackState } from "hdc/package/slack-collect.mjs";
import { CLUMP_CONFIG_EXAMPLE, normalizeSlackConfig, resolveAppManifestUrls } from "hdc/package/slack-config.mjs";
import { printSlackPortalChecklist } from "hdc/package/slack-checklist.mjs";
import { applyAppSync, planAppSync } from "hdc/package/slack-sync.mjs";
import { syncConfiguredAppIcons } from "hdc/package/slack-icon.mjs";
import {
  createSlackRunContext,
  loadHdcAgentsPublicUrl,
} from "hdc/package/slack-run-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure slack query --` to verify drift.",
  "After interactivity URL changes, reinstall or re-authorize if Slack requires it.",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[slack] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const appFilter = flagGet(flags, "app");
  const noRotate = flags["no-rotate"] === "1";
  const skipIcon = flags["skip-icon"] === "1";

  const reportCtx = createOperationReportContext({
    clumpId: "slack",
    clumpTitle: "Slack applications",
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

  const { config, api } = await createSlackRunContext(cfgRaw, {
    rotateTokens: !noRotate,
    log,
  });

  const hdcRoot = repoRoot();
  const privateRoot = hdcPrivateRoot(hdcRoot) || "";
  const publicUrl = loadHdcAgentsPublicUrl(privateRoot, hdcRoot);

  let appsToMaintain = config.managedApps;
  if (appFilter) {
    const one = config.appsById.get(appFilter);
    if (!one) throw new Error(`App not in config: ${appFilter}`);
    if (!one.managed) throw new Error(`App is not managed: ${appFilter}`);
    appsToMaintain = [one];
  }

  if (!appsToMaintain.length) {
    pushWarning(reportCtx, "No managed apps in config");
  }

  let overallOk = true;
  /** @type {object[]} */
  const results = [];
  let configDirty = false;
  const nextApps = Array.isArray(cfgRaw.apps) ? [...cfgRaw.apps] : [];

  for (const cfgApp of appsToMaintain) {
    if (!cfgApp.match.app_id) {
      pushWarning(reportCtx, `${cfgApp.id}: missing match.app_id — run deploy first`);
      recordStep(reportCtx, {
        name: `app:${cfgApp.id}`,
        ok: false,
        detail: "missing app_id",
      });
      overallOk = false;
      results.push({ id: cfgApp.id, action: "missing", ok: false });
      continue;
    }

    const urls = resolveAppManifestUrls(cfgApp, {
      hdcAgentsPublicUrl: publicUrl,
    });
    let liveManifest = {};
    try {
      const exported = await api.exportApp(cfgApp.match.app_id);
      liveManifest =
        exported.manifest && typeof exported.manifest === "object"
          ? /** @type {Record<string, unknown>} */ (exported.manifest)
          : {};
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordStep(reportCtx, {
        name: `app:${cfgApp.id}`,
        ok: false,
        detail: "export failed",
        error: msg,
      });
      overallOk = false;
      results.push({ id: cfgApp.id, ok: false, error: msg });
      continue;
    }

    const plan = planAppSync({
      configApp: cfgApp,
      live: { app_id: cfgApp.match.app_id, manifest: liveManifest },
      ...urls,
    });

    if (plan.action === "create") {
      pushWarning(reportCtx, `${cfgApp.id}: would create — run deploy first`);
      recordStep(reportCtx, {
        name: `app:${cfgApp.id}`,
        ok: false,
        detail: "needs deploy",
      });
      overallOk = false;
      results.push({ id: cfgApp.id, action: "create", ok: false });
      continue;
    }

    const applied = await applyAppSync(api, plan, {
      dryRun: reportCtx.dryRun,
      log,
    });
    recordStep(reportCtx, {
      name: `app:${cfgApp.id}`,
      ok: applied.ok,
      detail: applied.action,
      error: applied.error,
    });
    if (!applied.ok) overallOk = false;
    results.push({ id: cfgApp.id, ...applied });
  }

  if (!skipIcon && appsToMaintain.length) {
    const iconSync = await syncConfiguredAppIcons({
      api,
      apps: appsToMaintain,
      hdcRoot,
      configApps: nextApps,
      dryRun: reportCtx.dryRun,
      log,
    });
    for (const iconResult of iconSync.results) {
      recordStep(reportCtx, {
        name: `icon:${iconResult.id}`,
        ok: iconResult.ok !== false,
        detail: iconResult.action,
        error: iconResult.error,
      });
      if (iconResult.ok === false) overallOk = false;
    }
    if (iconSync.configDirty && !reportCtx.dryRun) {
      configDirty = true;
      nextApps.splice(0, nextApps.length, ...iconSync.nextApps);
    }
  }

  if (configDirty && !reportCtx.dryRun) {
    writeResolvedRepoJson(resolved, { ...cfgRaw, apps: nextApps }, {
      compactArrayKeys: ["apps", "bot_scopes"],
    });
    log(`wrote icon.applied_sha256 updates to ${resolved.rel}`);
  }

  printSlackPortalChecklist(appsToMaintain);

  const snapshotConfig = configDirty
    ? normalizeSlackConfig({ ...cfgRaw, apps: nextApps })
    : config;

  const snapshot = await collectSlackState({
    config: snapshotConfig,
    api,
    resolveOpts: { hdcAgentsPublicUrl: publicUrl, hdcRoot },
    log,
  });

  const payload = {
    ok: overallOk && snapshot.ok,
    package: "slack",
    verb,
    results,
    snapshot,
  };
  await runOperationReportTail({
    reportCtx,
    clumpRoot,
    repoRoot: hdcRoot,
    ok: payload.ok,
    payload,
    log,
  });
  log(payload.ok ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  process.exit(payload.ok ? 0 : 1);
}

main().catch((e) => {
  errout.write(`[slack] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
