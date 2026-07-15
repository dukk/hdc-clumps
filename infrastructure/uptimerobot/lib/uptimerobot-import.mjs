import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import {
  liveAccountToConfig,
  liveAlertContactToConfig,
  liveMonitorToConfig,
  liveStatusPageToConfig,
  parseUptimerobotId,
} from "./uptimerobot-config.mjs";

export const UPTIMEROBOT_COMPACT_ARRAY_KEYS = ["monitors", "status_pages", "alert_contacts"];

const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/uptimerobot/config.example.json";

/**
 * @param {Awaited<ReturnType<import('./uptimerobot-collect.mjs').fetchLiveUptimerobotState>>} live
 * @param {import('./uptimerobot-config.mjs').ConfigAlertContact[]} existingContacts
 * @param {import('./uptimerobot-config.mjs').ConfigMonitor[]} existingMonitors
 * @param {import('./uptimerobot-config.mjs').ConfigStatusPage[]} existingPages
 */
export function liveStateToConfigEntries(live, existingContacts, existingMonitors, existingPages) {
  const existingContactByUr = new Map(
    existingContacts
      .filter((c) => Number.isFinite(c.uptimerobot_id))
      .map((c) => [c.uptimerobot_id, c])
  );
  const existingMonitorByUr = new Map(
    existingMonitors
      .filter((m) => Number.isFinite(m.uptimerobot_id))
      .map((m) => [m.uptimerobot_id, m])
  );
  const existingPageByUr = new Map(
    existingPages
      .filter((p) => Number.isFinite(p.uptimerobot_id))
      .map((p) => [p.uptimerobot_id, p])
  );

  const usedIds = new Set([
    ...existingContacts.map((c) => c.id),
    ...existingMonitors.map((m) => m.id),
    ...existingPages.map((p) => p.id),
  ]);

  const alert_contacts = live.alertContacts
    .map((row) => {
      const existing = existingContactByUr.get(row.uptimerobot_id) ?? null;
      if (existing) usedIds.add(existing.id);
      return liveAlertContactToConfig(
        live.raw.alertContactRows.find((r) => parseUptimerobotId(r.id) === row.uptimerobot_id) ??
          {
            id: row.uptimerobot_id,
            friendly_name: row.friendly_name,
            type: row.type,
            status: row.status,
            value: row.value,
          },
        existing,
        usedIds
      );
    })
    .filter(Boolean)
    .sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));

  const contactIdByUptimerobotId = new Map(
    alert_contacts.map((c) => [c.uptimerobot_id, c.id])
  );

  const monitors = live.monitors
    .map((row) => {
      const existing = existingMonitorByUr.get(row.uptimerobot_id) ?? null;
      if (existing) usedIds.add(existing.id);
      return liveMonitorToConfig(
        live.raw.monitorRows.find((r) => parseUptimerobotId(r.id) === row.uptimerobot_id) ?? {
          id: row.uptimerobot_id,
          friendly_name: row.friendly_name,
          url: row.url,
          type: row.type,
          interval: row.interval_seconds,
          status: row.status,
          alert_contacts: row.alert_contacts,
          ...row.options,
        },
        existing,
        contactIdByUptimerobotId,
        usedIds
      );
    })
    .filter(Boolean)
    .sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));

  const monitorIdByUptimerobotId = new Map(monitors.map((m) => [m.uptimerobot_id, m.id]));

  const status_pages = live.statusPages
    .map((row) => {
      const existing = existingPageByUr.get(row.uptimerobot_id) ?? null;
      if (existing) usedIds.add(existing.id);
      return liveStatusPageToConfig(
        live.raw.pspRows.find((r) => parseUptimerobotId(r.id) === row.uptimerobot_id) ?? {
          id: row.uptimerobot_id,
          friendly_name: row.friendly_name,
          monitors: row.monitors === "all" ? 0 : row.monitors.join("-"),
          sort: row.sort,
          status: row.status,
          standard_url: row.standard_url,
          custom_url: row.custom_url,
        },
        existing,
        monitorIdByUptimerobotId,
        usedIds
      );
    })
    .filter(Boolean)
    .sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));

  return {
    account: liveAccountToConfig(live.account),
    alert_contacts,
    monitors,
    status_pages,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {Awaited<ReturnType<import('./uptimerobot-collect.mjs').fetchLiveUptimerobotState>>} opts.live
 * @param {(line: string) => void} [opts.log]
 */
export function importUptimerobotToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });

  const existingContacts = Array.isArray(cfgRaw.alert_contacts) ? cfgRaw.alert_contacts : [];
  const existingMonitors = Array.isArray(cfgRaw.monitors) ? cfgRaw.monitors : [];
  const existingPages = Array.isArray(cfgRaw.status_pages) ? cfgRaw.status_pages : [];

  const entries = liveStateToConfigEntries(
    opts.live,
    existingContacts,
    existingMonitors,
    existingPages
  );

  const urRaw =
    cfgRaw.uptimerobot && typeof cfgRaw.uptimerobot === "object" ? { ...cfgRaw.uptimerobot } : {};

  const next = {
    ...cfgRaw,
    uptimerobot: {
      ...urRaw,
      account: entries.account,
    },
    monitors: entries.monitors,
    status_pages: entries.status_pages,
    alert_contacts: entries.alert_contacts,
  };

  writeResolvedRepoJson(resolved, next, { compactArrayKeys: UPTIMEROBOT_COMPACT_ARRAY_KEYS });
  log(
    `Wrote ${entries.monitors.length} monitor(s), ${entries.status_pages.length} status page(s), ${entries.alert_contacts.length} alert contact(s) to config (${source}: ${resolved.rel}).`
  );

  return {
    monitor_count: entries.monitors.length,
    status_page_count: entries.status_pages.length,
    alert_contact_count: entries.alert_contacts.length,
    configPath: resolved.path,
    configRel: resolved.rel,
    source,
  };
}
