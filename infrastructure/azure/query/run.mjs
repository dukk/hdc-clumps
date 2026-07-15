#!/usr/bin/env node
/**
 * Azure query: Entra apps and/or compute deployments.
 *
 * Usage: hdc run infrastructure azure query --
 *   [--section entra|compute|all] [--app <config-id>] [--import] [--yes]
 *   [--live] (compute) [--instance a]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { applicationPassesFilter } from "hdc/package/azure-config.mjs";
import { collectAzureState } from "hdc/package/azure-collect.mjs";
import { importAzureToConfig } from "hdc/package/azure-import.mjs";
import { createAzureRunContext, CLUMP_CONFIG_EXAMPLE } from "hdc/package/azure-run-context.mjs";
import { resolveAzureSection } from "hdc/package/section.mjs";
import { runAzureComputeQuery } from "hdc/package/compute/run-compute-query.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[azure] ${line}\n`);
}

/**
 * @param {string} question
 */
async function confirm(question) {
  const rl = createInterface({ input, output: errout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

/**
 * @param {Record<string, string>} flags
 */
async function queryEntra(flags) {
  const appId = flagGet(flags, "app");
  const doImport = flags.import === "1";
  const yes = flags.yes === "1";

  if (doImport) {
    log(
      "import: merge live Entra apps into entra.applications (preserve id/managed on match; write entra/applications/*.json)."
    );
  }

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    bootstrapFromExample: doImport,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const { config, api, tenantId, clientId } = await createAzureRunContext(cfgRaw);
  log(`tenant ${tenantId}, client_id ${clientId}: fetching applications from Microsoft Graph`);

  /** @type {{ application_count: number; config_rel: string; layout?: string } | null} */
  let importResult = null;

  if (doImport) {
    const allApps = await api.listApplications();
    if (!yes) {
      const filteredCount = allApps.filter((a) =>
        applicationPassesFilter(a.displayName, config.applicationFilter)
      ).length;
      const ok = await confirm(
        `Merge ${filteredCount} app registration(s) into entra.applications (preserve id/managed; drop config-only unmatched)? [y/N] `
      );
      if (!ok) {
        errout.write("[azure] Aborted: import not confirmed (use --yes to skip prompt).\n");
        process.exitCode = 1;
        return null;
      }
    }
    const written = importAzureToConfig({
      clumpRoot,
      liveApps: allApps,
      applicationFilter: config.applicationFilter,
      log,
    });
    importResult = {
      application_count: written.application_count,
      config_rel: written.configRel,
      layout: written.layout,
    };
    log(`import complete: ${written.configRel}`);
  }

  let configForCollect = config;
  if (doImport) {
    const reloaded = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: CLUMP_CONFIG_EXAMPLE,
      log: () => {},
    });
    configForCollect = (await createAzureRunContext(reloaded.data)).config;
  }

  const state = await collectAzureState({
    config: configForCollect,
    api,
    appFilterId: appId,
  });

  const ok =
    state.configured_missing.length === 0 &&
    !state.managed_applications.some((m) => m.drift);

  const payload = {
    ok,
    verb: "query",
    package: "azure",
    section: "entra",
    config_source: source,
    tenant_id: tenantId,
    application_filter: configForCollect.applicationFilter,
    managed_config_ids: configForCollect.managedApplications.map((a) => a.id),
    ...state,
    import: importResult,
    collected_at: new Date().toISOString(),
    summary:
      "Entra app registration snapshot. Use --import --yes to refresh hdc-private entra/applications.",
  };

  if (state.configured_missing.length) {
    log(
      `warning: managed apps missing in tenant: ${state.configured_missing.map((m) => m.config_id).join(", ")}`
    );
  }
  if (!ok && !doImport) {
    log("warning: live tenant differs from config (run with --import --yes to refresh)");
  }
  log(
    `done: ${state.filtered_application_count} apps in scan (${state.unmanaged_applications.length} unmanaged, ${state.configured_missing.length} missing)`
  );

  return payload;
}

async function main() {
  log(`${verb}: starting`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const section = resolveAzureSection(flags, { allowAll: true, defaultSection: "entra" });
  log(`section=${section}`);

  if (section === "compute") {
    await runAzureComputeQuery({ clumpRoot, flags, printJson: true });
    return;
  }

  if (section === "entra") {
    const payload = await queryEntra(flags);
    if (payload) console.log(JSON.stringify(payload, null, 2));
    return;
  }

  // all (import still applies to entra when --import is set)
  const entra = await queryEntra(flags);
  if (!entra && flags.import === "1") return;
  const compute = await runAzureComputeQuery({ clumpRoot, flags, printJson: false });
  const ok = Boolean(entra?.ok) && Boolean(compute?.ok);
  console.log(
    JSON.stringify(
      {
        ok,
        verb: "query",
        package: "azure",
        section: "all",
        entra,
        compute,
        collected_at: new Date().toISOString(),
      },
      null,
      2
    )
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
