#!/usr/bin/env node
/**
 * UptimeRobot maintain: reconcile managed monitors, status pages, and alert contacts.
 *
 * Usage: hdc run infrastructure uptimerobot maintain --
 *   [--dry-run] [--prune] [--monitor <id>] [--status-page <id>] [--contact <id>]
 *   [--skip-monitors] [--skip-status-pages] [--skip-alert-contacts]
 *   [--no-report] [--report <path>]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  createOperationReportContext,
  recordStep,
  runOperationReportTail,
  pushWarning,
} from "hdc/package/operation-report.mjs";
import { createUptimerobotClient } from "hdc/package/uptimerobot-api.mjs";
import { liveMonitorToConfig, normalizeUptimerobotConfig } from "hdc/package/uptimerobot-config.mjs";
import { fetchLiveUptimerobotState } from "hdc/package/uptimerobot-collect.mjs";
import {
  applyAlertContactDelete,
  applyAlertContactSync,
  planAlertContactDelete,
  planAlertContactSync,
} from "hdc/package/uptimerobot-alert-contacts-sync.mjs";
import {
  applyMonitorDelete,
  applyMonitorSync,
  planMonitorDelete,
  planMonitorSync,
} from "hdc/package/uptimerobot-monitors-sync.mjs";
import {
  applyStatusPageDelete,
  applyStatusPageSync,
  planStatusPageDelete,
  planStatusPageSync,
} from "hdc/package/uptimerobot-status-pages-sync.mjs";
import {
  createUptimerobotVaultAccess,
  resolveUptimerobotApiKey,
} from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/uptimerobot/config.example.json";

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure uptimerobot query --` to verify live vs config drift.",
  "Set `managed: true` only on entries hdc should create or update.",
  "Run `query --import --yes` before `--prune` so config lists the full inventory.",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[uptimerobot] ${line}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const monitorFilter = flagGet(flags, "monitor");
  const statusPageFilter = flagGet(flags, "status-page");
  const contactFilter = flagGet(flags, "contact");
  const skipMonitors = flags["skip-monitors"] === "1";
  const skipStatusPages = flags["skip-status-pages"] === "1";
  const skipAlertContacts = flags["skip-alert-contacts"] === "1";
  const prune = flags.prune === "1";

  const reportCtx = createOperationReportContext({
    clumpId: "uptimerobot",
    clumpTitle: "UptimeRobot",
    verb,
    argv,
    manifestNextSteps: MANIFEST_NEXT_STEPS,
    extraFlags: { skipMonitors, skipStatusPages, skipAlertContacts, prune },
  });

  log(
    `${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}${prune ? " (prune)" : ""}`
  );

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  const config = normalizeUptimerobotConfig(cfgRaw);
  const vault = createUptimerobotVaultAccess();
  const apiKey = await resolveUptimerobotApiKey(vault, config.apiKeyVaultKey);
  log(`API key loaded (${config.apiKeyVaultKey})`);

  const api = createUptimerobotClient({
    apiKey,
    apiBaseUrl: config.apiBase,
  });

  const live = await fetchLiveUptimerobotState(api, log);

  const liveContactsByUr = new Map(live.alertContacts.map((c) => [c.uptimerobot_id, c]));
  const liveMonitorsByUr = new Map(live.monitors.map((m) => [m.uptimerobot_id, m]));
  const livePagesByUr = new Map(live.statusPages.map((p) => [p.uptimerobot_id, p]));

  const contactUptimerobotIdByHdcId = new Map(
    config.alert_contacts.map((c) => [c.id, c.uptimerobot_id])
  );
  const monitorUptimerobotIdByHdcId = new Map(
    config.monitors.map((m) => [m.id, m.uptimerobot_id])
  );

  const contactIdByUptimerobotId = new Map(
    config.alert_contacts.map((c) => [c.uptimerobot_id, c.id])
  );

  let overallOk = true;

  if (!skipAlertContacts) {
    let contacts = config.alert_contacts.filter((c) => c.managed);
    if (contactFilter) {
      const one = config.alertContactsById.get(contactFilter);
      if (!one) throw new Error(`Alert contact id not in config: ${contactFilter}`);
      if (!one.managed) throw new Error(`Alert contact is not managed: ${contactFilter}`);
      contacts = [one];
    }

    if (!contacts.length) {
      pushWarning(reportCtx, "No managed alert_contacts[] entries to maintain.");
    }

    for (const entry of contacts) {
      const liveRow = liveContactsByUr.get(entry.uptimerobot_id) ?? null;
      const plan = planAlertContactSync({ entry, live: liveRow });
      log(`alert contact ${entry.id}: plan action=${plan.action}`);
      const result = await applyAlertContactSync(api, plan, entry, {
        dryRun: reportCtx.dryRun,
        log,
      });
      recordStep(reportCtx, {
        id: `contact-${entry.id}`,
        title: `Maintain alert contact: ${entry.friendly_name}`,
        ran: plan.action !== "skip" && plan.action !== "unchanged",
        skipReason:
          plan.action === "skip"
            ? plan.reason
            : plan.action === "unchanged"
              ? "unchanged"
              : undefined,
        ok: result.ok,
        notes: result.error ? [result.error] : [],
      });
      if (!result.ok) overallOk = false;
    }

    if (prune) {
      const configUrIds = new Set(config.alert_contacts.map((c) => c.uptimerobot_id));
      for (const liveRow of live.alertContacts) {
        if (configUrIds.has(liveRow.uptimerobot_id)) continue;
        const plan = planAlertContactDelete({
          id: liveRow.id,
          uptimerobotId: liveRow.uptimerobot_id,
          managed: config.alert_contacts.some((c) => c.managed),
        });
        if (plan.action === "skip") continue;
        log(`prune alert contact ${liveRow.id}: not in config`);
        const result = await applyAlertContactDelete(api, plan, {
          dryRun: reportCtx.dryRun,
          log,
        });
        recordStep(reportCtx, {
          id: `prune-contact-${liveRow.uptimerobot_id}`,
          title: `Prune alert contact: ${liveRow.friendly_name}`,
          ran: true,
          ok: result.ok,
          notes: result.error ? [result.error] : ["removed from live (not in config)"],
        });
        if (!result.ok) overallOk = false;
      }
    }
  } else {
    log("skip alert contacts (--skip-alert-contacts)");
  }

  if (!skipMonitors) {
    let monitors = config.monitors.filter((m) => m.managed);
    if (monitorFilter) {
      const one = config.monitorsById.get(monitorFilter);
      if (!one) throw new Error(`Monitor id not in config: ${monitorFilter}`);
      if (!one.managed) throw new Error(`Monitor is not managed: ${monitorFilter}`);
      monitors = [one];
    }

    if (!monitors.length) {
      pushWarning(reportCtx, "No managed monitors[] entries to maintain.");
    }

    for (const entry of monitors) {
      const liveRow =
        liveMonitorsByUr.get(entry.uptimerobot_id) ??
        (() => {
          const raw = live.raw.monitorRows.find(
            (r) => Number(r.id) === entry.uptimerobot_id
          );
          if (!raw) return null;
          return liveMonitorToConfig(raw, null, contactIdByUptimerobotId, new Set());
        })();
      const plan = planMonitorSync({ entry, live: liveRow });
      log(`monitor ${entry.id}: plan action=${plan.action}`);
      const result = await applyMonitorSync(api, plan, entry, contactUptimerobotIdByHdcId, {
        dryRun: reportCtx.dryRun,
        log,
      });
      recordStep(reportCtx, {
        id: `monitor-${entry.id}`,
        title: `Maintain monitor: ${entry.friendly_name}`,
        ran: plan.action !== "skip" && plan.action !== "unchanged",
        skipReason:
          plan.action === "skip"
            ? plan.reason
            : plan.action === "unchanged"
              ? "unchanged"
              : undefined,
        ok: result.ok,
        notes: result.error ? [result.error] : [],
      });
      if (!result.ok) overallOk = false;
    }

    if (prune) {
      const configUrIds = new Set(config.monitors.map((m) => m.uptimerobot_id));
      const hasManaged = config.monitors.some((m) => m.managed);
      for (const liveRow of live.monitors) {
        if (configUrIds.has(liveRow.uptimerobot_id)) continue;
        const plan = planMonitorDelete({
          id: liveRow.id,
          uptimerobotId: liveRow.uptimerobot_id,
          managed: hasManaged,
        });
        if (plan.action === "skip") continue;
        log(`prune monitor ${liveRow.id}: not in config`);
        const result = await applyMonitorDelete(api, plan, {
          dryRun: reportCtx.dryRun,
          log,
        });
        recordStep(reportCtx, {
          id: `prune-monitor-${liveRow.uptimerobot_id}`,
          title: `Prune monitor: ${liveRow.friendly_name}`,
          ran: true,
          ok: result.ok,
          notes: result.error ? [result.error] : ["removed from live (not in config)"],
        });
        if (!result.ok) overallOk = false;
      }
    }
  } else {
    log("skip monitors (--skip-monitors)");
  }

  if (!skipStatusPages) {
    let pages = config.status_pages.filter((p) => p.managed);
    if (statusPageFilter) {
      const one = config.statusPagesById.get(statusPageFilter);
      if (!one) throw new Error(`Status page id not in config: ${statusPageFilter}`);
      if (!one.managed) throw new Error(`Status page is not managed: ${statusPageFilter}`);
      pages = [one];
    }

    if (!pages.length) {
      pushWarning(reportCtx, "No managed status_pages[] entries to maintain.");
    }

    for (const entry of pages) {
      const liveRow = livePagesByUr.get(entry.uptimerobot_id) ?? null;
      const plan = planStatusPageSync({ entry, live: liveRow });
      log(`status page ${entry.id}: plan action=${plan.action}`);
      const result = await applyStatusPageSync(api, plan, entry, monitorUptimerobotIdByHdcId, {
        dryRun: reportCtx.dryRun,
        log,
      });
      recordStep(reportCtx, {
        id: `status-page-${entry.id}`,
        title: `Maintain status page: ${entry.friendly_name}`,
        ran: plan.action !== "skip" && plan.action !== "unchanged",
        skipReason:
          plan.action === "skip"
            ? plan.reason
            : plan.action === "unchanged"
              ? "unchanged"
              : undefined,
        ok: result.ok,
        notes: result.error ? [result.error] : [],
      });
      if (!result.ok) overallOk = false;
    }

    if (prune) {
      const configUrIds = new Set(config.status_pages.map((p) => p.uptimerobot_id));
      const hasManaged = config.status_pages.some((p) => p.managed);
      for (const liveRow of live.statusPages) {
        if (configUrIds.has(liveRow.uptimerobot_id)) continue;
        const plan = planStatusPageDelete({
          id: liveRow.id,
          uptimerobotId: liveRow.uptimerobot_id,
          managed: hasManaged,
        });
        if (plan.action === "skip") continue;
        log(`prune status page ${liveRow.id}: not in config`);
        const result = await applyStatusPageDelete(api, plan, {
          dryRun: reportCtx.dryRun,
          log,
        });
        recordStep(reportCtx, {
          id: `prune-status-page-${liveRow.uptimerobot_id}`,
          title: `Prune status page: ${liveRow.friendly_name}`,
          ran: true,
          ok: result.ok,
          notes: result.error ? [result.error] : ["removed from live (not in config)"],
        });
        if (!result.ok) overallOk = false;
      }
    }
  } else {
    log("skip status pages (--skip-status-pages)");
  }

  await runOperationReportTail({
    clumpRoot,
    repoRoot: repoRoot(),
    verb,
    argv,
    payload: {
      ok: overallOk,
      verb: "maintain",
      package: "uptimerobot",
      config_source: source,
      dry_run: reportCtx.dryRun,
      prune,
    },
    ok: overallOk,
    log,
    reportCtx,
  });
  if (!overallOk) process.exitCode = 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
