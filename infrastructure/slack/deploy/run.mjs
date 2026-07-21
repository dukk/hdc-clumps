#!/usr/bin/env node
/**
 * Slack deploy: create managed apps via App Manifest API.
 *
 * Usage: hdc run infrastructure slack deploy --
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
import { CLUMP_CONFIG_EXAMPLE } from "hdc/package/slack-config.mjs";
import { resolveAppManifestUrls } from "hdc/package/slack-config.mjs";
import { printSlackPortalChecklist } from "hdc/package/slack-checklist.mjs";
import { applyAppSync, planAppSync } from "hdc/package/slack-sync.mjs";
import { syncConfiguredAppIcons } from "hdc/package/slack-icon.mjs";
import {
  createSlackRunContext,
  loadHdcAgentsPublicUrl,
} from "hdc/package/slack-run-context.mjs";
import { writeSlackVaultSecret } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

const MANIFEST_NEXT_STEPS = [
  "Install the app to the workspace and `hdc secrets set HDC_SLACK_BOT_TOKEN`.",
  "Set HDC_SLACK_DECISION_CHANNEL and enable notifications.channels.slack-hdc-app.",
  "Run `hdc run infrastructure slack query --` to verify drift.",
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

  const { config, api, vault } = await createSlackRunContext(cfgRaw, {
    rotateTokens: !noRotate,
    log,
  });

  const hdcRoot = repoRoot();
  const privateRoot = hdcPrivateRoot(hdcRoot) || "";
  const publicUrl = loadHdcAgentsPublicUrl(privateRoot, hdcRoot);

  let appsToDeploy = config.managedApps;
  if (appFilter) {
    const one = config.appsById.get(appFilter);
    if (!one) throw new Error(`App not in config: ${appFilter}`);
    if (!one.managed) throw new Error(`App is not managed: ${appFilter}`);
    appsToDeploy = [one];
  }

  if (!appsToDeploy.length) {
    pushWarning(reportCtx, "No managed apps in config");
  }

  let overallOk = true;
  /** @type {object[]} */
  const results = [];
  let configDirty = false;
  const nextApps = Array.isArray(cfgRaw.apps) ? [...cfgRaw.apps] : [];

  for (const cfgApp of appsToDeploy) {
    const urls = resolveAppManifestUrls(cfgApp, {
      hdcAgentsPublicUrl: publicUrl,
    });
    const live = cfgApp.match.app_id
      ? {
          app_id: cfgApp.match.app_id,
          manifest: (
            await api.exportApp(cfgApp.match.app_id).catch(() => ({ manifest: {} }))
          ).manifest,
        }
      : null;

    const plan = planAppSync({ configApp: cfgApp, live, ...urls });
    if (plan.action !== "create") {
      log(`app ${cfgApp.id}: skip (${plan.action})`);
      recordStep(reportCtx, {
        name: `app:${cfgApp.id}`,
        ok: true,
        detail: plan.action,
      });
      results.push({ id: cfgApp.id, action: plan.action });
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

    if (applied.ok && applied.appId && !reportCtx.dryRun) {
      const idx = nextApps.findIndex((a) => a && a.id === cfgApp.id);
      if (idx >= 0) {
        nextApps[idx] = {
          ...nextApps[idx],
          match: { ...(nextApps[idx].match || {}), app_id: applied.appId },
        };
        configDirty = true;
      }
      const creds = applied.credentials || {};
      if (creds.signing_secret) {
        await writeSlackVaultSecret(vault, cfgApp.vault.signing_secret_key, creds.signing_secret);
        log(`vault: wrote ${cfgApp.vault.signing_secret_key}`);
      }
      if (creds.client_id) {
        await writeSlackVaultSecret(vault, cfgApp.vault.client_id_key, creds.client_id);
      }
      if (creds.client_secret) {
        await writeSlackVaultSecret(vault, cfgApp.vault.client_secret_key, creds.client_secret);
      }
    }
    results.push({ id: cfgApp.id, ...applied });
  }

  if (!skipIcon && appsToDeploy.length) {
    const iconSync = await syncConfiguredAppIcons({
      api,
      apps: appsToDeploy,
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
      nextApps.splice(0, nextApps.length, ...iconSync.nextApps);
      configDirty = true;
    }
  }

  if (configDirty && !reportCtx.dryRun) {
    writeResolvedRepoJson(resolved, { ...cfgRaw, apps: nextApps }, {
      compactArrayKeys: ["apps", "bot_scopes"],
    });
    log(`wrote match.app_id updates to ${resolved.rel}`);
  }

  printSlackPortalChecklist(appsToDeploy);

  const payload = { ok: overallOk, package: "slack", verb, results };
  await runOperationReportTail({
    reportCtx,
    clumpRoot,
    repoRoot: hdcRoot,
    ok: overallOk,
    payload,
    log,
  });
  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  process.exit(overallOk ? 0 : 1);
}

main().catch(async (e) => {
  errout.write(`[slack] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
