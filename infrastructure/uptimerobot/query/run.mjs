#!/usr/bin/env node
/**
 * UptimeRobot query: diff monitors, status pages, and alert contacts vs config (JSON on stdout).
 *
 * Usage: hdc run infrastructure uptimerobot query --
 *   [--import] [--yes] [--monitor <id>] [--status-page <id>] [--contact <id>]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createUptimerobotClient } from "hdc/package/uptimerobot-api.mjs";
import { normalizeUptimerobotConfig } from "hdc/package/uptimerobot-config.mjs";
import {
  collectUptimerobotState,
  fetchLiveUptimerobotState,
} from "hdc/package/uptimerobot-collect.mjs";
import { importUptimerobotToConfig } from "hdc/package/uptimerobot-import.mjs";
import {
  createUptimerobotVaultAccess,
  resolveUptimerobotApiKey,
} from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/uptimerobot/config.example.json";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[uptimerobot] ${line}\n`);
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

async function main() {
  log(`${verb}: starting`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const monitorId = flagGet(flags, "monitor");
  const statusPageId = flagGet(flags, "status-page");
  const contactId = flagGet(flags, "contact");
  const doImport = flags.import === "1";
  const yes = flags.yes === "1";

  if (doImport) {
    log(
      "import: will replace monitors[], status_pages[], and alert_contacts[] in config.json from live API."
    );
  }

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    bootstrapFromExample: doImport,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  let config = normalizeUptimerobotConfig(cfgRaw);
  const vault = createUptimerobotVaultAccess();
  const apiKey = await resolveUptimerobotApiKey(vault, config.apiKeyVaultKey);
  log(`API key loaded (${config.apiKeyVaultKey})`);

  const api = createUptimerobotClient({
    apiKey,
    apiBaseUrl: config.apiBase,
  });

  /** @type {{ monitor_count: number; status_page_count: number; alert_contact_count: number; config_rel: string } | null} */
  let importResult = null;

  const live = await fetchLiveUptimerobotState(api, log);

  if (doImport) {
    if (!yes) {
      const ok = await confirm(
        `Replace monitors[], status_pages[], and alert_contacts[] with ${live.monitors.length} monitor(s), ${live.statusPages.length} status page(s), and ${live.alertContacts.length} alert contact(s)? [y/N] `
      );
      if (!ok) {
        errout.write("[uptimerobot] Aborted: import not confirmed (use --yes to skip prompt).\n");
        process.exitCode = 1;
        return;
      }
    }
    const written = importUptimerobotToConfig({ clumpRoot, live, log });
    importResult = {
      monitor_count: written.monitor_count,
      status_page_count: written.status_page_count,
      alert_contact_count: written.alert_contact_count,
      config_rel: written.configRel,
    };
    const { data: cfgAfterImport } = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: CLUMP_CONFIG_EXAMPLE,
      log: (line) => errout.write(line),
    });
    config = normalizeUptimerobotConfig(cfgAfterImport);
    log(`import complete: ${written.configRel}`);
  }

  const state = collectUptimerobotState({
    config,
    live,
    monitorFilterId: monitorId,
    statusPageFilterId: statusPageId,
    contactFilterId: contactId,
  });

  const ok = !state.has_drift;

  const payload = {
    ok,
    verb: "query",
    package: "uptimerobot",
    config_source: source,
    account: state.account,
    monitors: state.monitors,
    status_pages: state.status_pages,
    alert_contacts: state.alert_contacts,
    has_drift: state.has_drift,
    has_monitor_drift: state.has_monitor_drift,
    has_contact_drift: state.has_contact_drift,
    has_status_page_drift: state.has_status_page_drift,
    live_monitor_count: state.live_monitor_count,
    live_status_page_count: state.live_status_page_count,
    live_contact_count: state.live_contact_count,
    configured_monitor_count: state.configured_monitor_count,
    configured_status_page_count: state.configured_status_page_count,
    configured_contact_count: state.configured_contact_count,
    monitor_filter: state.monitor_filter,
    status_page_filter: state.status_page_filter,
    contact_filter: state.contact_filter,
    primary_status_page_url: state.primary_status_page_url,
    import: importResult,
    collected_at: new Date().toISOString(),
    summary:
      "UptimeRobot snapshot (monitors, status pages, alert contacts). Use --import --yes to bootstrap hdc-private config.",
  };

  if (state.has_drift) {
    log("warning: live account differs from config (run with --import --yes to refresh)");
  }
  log(
    `done: ${state.live_monitor_count} live monitor(s), ${state.live_status_page_count} live status page(s), ${state.live_contact_count} live alert contact(s)`
  );

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (state.has_drift && !doImport) process.exitCode = 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
