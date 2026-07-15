import { createUptimerobotClient } from "./uptimerobot-api.mjs";
import {
  alertContactHasDrift,
  liveAccountToConfig,
  liveAlertContactToConfig,
  liveMonitorToConfig,
  liveStatusPageToConfig,
  monitorHasDrift,
  statusPageHasDrift,
} from "./uptimerobot-config.mjs";

/**
 * @param {ReturnType<typeof createUptimerobotClient>} api
 * @param {(line: string) => void} [log]
 */
export async function fetchLiveUptimerobotState(api, log = () => {}) {
  log("fetching account details");
  const account = await api.getAccountDetails();

  log("fetching alert contacts");
  const alertContactRows = await api.listAlertContacts();

  const usedContactIds = new Set(
    alertContactRows
      .map((r) => String(r.id ?? "").trim())
      .filter(Boolean)
  );

  /** @type {Map<number, import('./uptimerobot-config.mjs').ConfigAlertContact>} */
  const existingContactsByUrId = new Map();

  const usedIds = new Set();
  /** @type {import('./uptimerobot-config.mjs').ConfigAlertContact[]} */
  const alertContacts = alertContactRows
    .map((row) => liveAlertContactToConfig(row, null, usedIds))
    .filter(Boolean);

  const contactIdByUptimerobotId = new Map(
    alertContacts.map((c) => [c.uptimerobot_id, c.id])
  );

  log("fetching monitors");
  const monitorRows = await api.listMonitors();
  /** @type {import('./uptimerobot-config.mjs').ConfigMonitor[]} */
  const monitors = monitorRows
    .map((row) => liveMonitorToConfig(row, null, contactIdByUptimerobotId, usedIds))
    .filter(Boolean);

  const monitorIdByUptimerobotId = new Map(monitors.map((m) => [m.uptimerobot_id, m.id]));

  log("fetching status pages");
  const pspRows = await api.listPsps();
  /** @type {import('./uptimerobot-config.mjs').ConfigStatusPage[]} */
  const statusPages = pspRows
    .map((row) => liveStatusPageToConfig(row, null, monitorIdByUptimerobotId, usedIds))
    .filter(Boolean);

  return {
    account: liveAccountToConfig(account),
    alertContacts,
    monitors,
    statusPages,
    raw: {
      alertContactRows,
      monitorRows,
      pspRows,
    },
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./uptimerobot-config.mjs').normalizeUptimerobotConfig>} opts.config
 * @param {Awaited<ReturnType<typeof fetchLiveUptimerobotState>>} opts.live
 * @param {string | undefined} [opts.monitorFilterId]
 * @param {string | undefined} [opts.statusPageFilterId]
 * @param {string | undefined} [opts.contactFilterId]
 */
export function collectUptimerobotState(opts) {
  const { config, live, monitorFilterId, statusPageFilterId, contactFilterId } = opts;

  const configMonitors = monitorFilterId
    ? config.monitors.filter((m) => m.id === monitorFilterId)
    : config.monitors;
  const liveMonitors = monitorFilterId
    ? live.monitors.filter((m) => m.id === monitorFilterId)
    : live.monitors;

  if (monitorFilterId && configMonitors.length === 0 && liveMonitors.length === 0) {
    throw new Error(`Monitor not found in config or live account: ${monitorFilterId}`);
  }

  const configContacts = contactFilterId
    ? config.alert_contacts.filter((c) => c.id === contactFilterId)
    : config.alert_contacts;
  const liveContacts = contactFilterId
    ? live.alertContacts.filter((c) => c.id === contactFilterId)
    : live.alertContacts;

  if (contactFilterId && configContacts.length === 0 && liveContacts.length === 0) {
    throw new Error(`Alert contact not found in config or live account: ${contactFilterId}`);
  }

  const configPages = statusPageFilterId
    ? config.status_pages.filter((p) => p.id === statusPageFilterId)
    : config.status_pages;
  const livePages = statusPageFilterId
    ? live.statusPages.filter((p) => p.id === statusPageFilterId)
    : live.statusPages;

  if (statusPageFilterId && configPages.length === 0 && livePages.length === 0) {
    throw new Error(`Status page not found in config or live account: ${statusPageFilterId}`);
  }

  /** @type {{ id: string; uptimerobot_id: number; drift: boolean; missing_in_live: boolean; missing_in_config: boolean }[]} */
  const monitors = [];
  let monitorDrift = false;

  const liveMonByUr = new Map(liveMonitors.map((m) => [m.uptimerobot_id, m]));
  const cfgMonByUr = new Map(configMonitors.map((m) => [m.uptimerobot_id, m]));

  for (const cfg of configMonitors) {
    const liveRow = liveMonByUr.get(cfg.uptimerobot_id);
    if (!liveRow) {
      monitorDrift = true;
      monitors.push({
        id: cfg.id,
        uptimerobot_id: cfg.uptimerobot_id,
        drift: true,
        missing_in_live: true,
        missing_in_config: false,
      });
      continue;
    }
    const drift = monitorHasDrift(cfg, liveRow);
    if (drift) monitorDrift = true;
    monitors.push({
      id: cfg.id,
      uptimerobot_id: cfg.uptimerobot_id,
      drift,
      missing_in_live: false,
      missing_in_config: false,
    });
  }

  for (const liveRow of liveMonitors) {
    if (!cfgMonByUr.has(liveRow.uptimerobot_id)) {
      monitorDrift = true;
      monitors.push({
        id: liveRow.id,
        uptimerobot_id: liveRow.uptimerobot_id,
        drift: true,
        missing_in_live: false,
        missing_in_config: true,
      });
    }
  }

  /** @type {{ id: string; uptimerobot_id: number; drift: boolean; missing_in_live: boolean; missing_in_config: boolean }[]} */
  const alert_contacts = [];
  let contactDrift = false;

  const liveContactByUr = new Map(liveContacts.map((c) => [c.uptimerobot_id, c]));
  const cfgContactByUr = new Map(configContacts.map((c) => [c.uptimerobot_id, c]));

  for (const cfg of configContacts) {
    const liveRow = liveContactByUr.get(cfg.uptimerobot_id);
    if (!liveRow) {
      contactDrift = true;
      alert_contacts.push({
        id: cfg.id,
        uptimerobot_id: cfg.uptimerobot_id,
        drift: true,
        missing_in_live: true,
        missing_in_config: false,
      });
      continue;
    }
    const drift = alertContactHasDrift(cfg, liveRow);
    if (drift) contactDrift = true;
    alert_contacts.push({
      id: cfg.id,
      uptimerobot_id: cfg.uptimerobot_id,
      drift,
      missing_in_live: false,
      missing_in_config: false,
    });
  }

  for (const liveRow of liveContacts) {
    if (!cfgContactByUr.has(liveRow.uptimerobot_id)) {
      contactDrift = true;
      alert_contacts.push({
        id: liveRow.id,
        uptimerobot_id: liveRow.uptimerobot_id,
        drift: true,
        missing_in_live: false,
        missing_in_config: true,
      });
    }
  }

  /** @type {{ id: string; uptimerobot_id: number; drift: boolean; missing_in_live: boolean; missing_in_config: boolean; primary_match?: boolean }[]} */
  const status_pages = [];
  let pageDrift = false;

  const livePageByUr = new Map(livePages.map((p) => [p.uptimerobot_id, p]));
  const cfgPageByUr = new Map(configPages.map((p) => [p.uptimerobot_id, p]));

  for (const cfg of configPages) {
    const liveRow = livePageByUr.get(cfg.uptimerobot_id);
    if (!liveRow) {
      pageDrift = true;
      status_pages.push({
        id: cfg.id,
        uptimerobot_id: cfg.uptimerobot_id,
        drift: true,
        missing_in_live: true,
        missing_in_config: false,
      });
      continue;
    }
    const drift = statusPageHasDrift(cfg, liveRow);
    if (drift) pageDrift = true;
    status_pages.push({
      id: cfg.id,
      uptimerobot_id: cfg.uptimerobot_id,
      drift,
      missing_in_live: false,
      missing_in_config: false,
      primary_match:
        config.primaryStatusPageUrl != null &&
        liveRow.standard_url === config.primaryStatusPageUrl,
    });
  }

  for (const liveRow of livePages) {
    if (!cfgPageByUr.has(liveRow.uptimerobot_id)) {
      pageDrift = true;
      status_pages.push({
        id: liveRow.id,
        uptimerobot_id: liveRow.uptimerobot_id,
        drift: true,
        missing_in_live: false,
        missing_in_config: true,
        primary_match:
          config.primaryStatusPageUrl != null &&
          liveRow.standard_url === config.primaryStatusPageUrl,
      });
    }
  }

  const has_drift = monitorDrift || contactDrift || pageDrift;

  return {
    account: live.account,
    monitors,
    alert_contacts,
    status_pages,
    has_drift,
    has_monitor_drift: monitorDrift,
    has_contact_drift: contactDrift,
    has_status_page_drift: pageDrift,
    live_monitor_count: live.monitors.length,
    live_contact_count: live.alertContacts.length,
    live_status_page_count: live.statusPages.length,
    configured_monitor_count: config.monitors.length,
    configured_contact_count: config.alert_contacts.length,
    configured_status_page_count: config.status_pages.length,
    monitor_filter: monitorFilterId ?? null,
    contact_filter: contactFilterId ?? null,
    status_page_filter: statusPageFilterId ?? null,
    primary_status_page_url: config.primaryStatusPageUrl,
  };
}
