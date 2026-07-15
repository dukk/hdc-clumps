import {
  buildPublicGroupListForSave,
  statusPageHasDrift,
  statusPageToSaveConfig,
} from "./uptime-kuma-status-page-config.mjs";

/**
 * @typedef {import('./uptime-kuma-status-page-config.mjs').ConfigStatusPage} ConfigStatusPage
 * @typedef {import('./uptime-kuma-config.mjs').ConfigMonitor} ConfigMonitor
 */

/**
 * @param {object} opts
 * @param {ConfigStatusPage} opts.entry
 * @param {ConfigStatusPage | null} opts.live
 */
export function planStatusPageSync(opts) {
  const { entry, live } = opts;

  if (!entry.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      id: entry.id,
      slug: entry.slug,
      reason: "not managed",
      unchanged: true,
    };
  }

  if (!live) {
    return {
      action: /** @type {"add"} */ ("add"),
      id: entry.id,
      slug: entry.slug,
      unchanged: false,
    };
  }

  if (statusPageHasDrift(entry, live)) {
    return {
      action: /** @type {"save"} */ ("save"),
      id: entry.id,
      slug: entry.slug,
      unchanged: false,
    };
  }

  return {
    action: /** @type {"unchanged"} */ ("unchanged"),
    id: entry.id,
    slug: entry.slug,
    unchanged: true,
  };
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {ReturnType<typeof planStatusPageSync>} plan
 * @param {ConfigStatusPage} entry
 * @param {import('./uptime-kuma-config.mjs').ConfigMonitor[]} configMonitors
 * @param {import('./uptime-kuma-config.mjs').LiveMonitor[]} liveMonitors
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyStatusPageSync(client, plan, entry, configMonitors, liveMonitors, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip status page ${entry.id} (${plan.reason})`);
    return { ok: true, action: "skip", id: entry.id, slug: entry.slug };
  }

  if (plan.action === "unchanged") {
    log(`unchanged status page ${entry.id}`);
    return { ok: true, action: "unchanged", id: entry.id, slug: entry.slug };
  }

  if (plan.action === "add") {
    try {
      if (dryRun) {
        log(`dry-run: would add status page ${entry.slug} (${entry.title})`);
        return { ok: true, action: "add", id: entry.id, slug: entry.slug, dryRun: true };
      }
      await client.addStatusPage(entry.title, entry.slug);
      log(`added status page ${entry.slug}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed add status page ${entry.slug}: ${msg}`);
      return { ok: false, action: "add", id: entry.id, slug: entry.slug, error: msg };
    }
  }

  if (plan.action === "add" || plan.action === "save") {
    try {
      const publicGroupList = buildPublicGroupListForSave(entry, configMonitors, liveMonitors);
      const config = statusPageToSaveConfig(entry);
      const imgDataUrl = entry.icon ?? "/icon.svg";
      if (dryRun) {
        log(`dry-run: would save status page ${entry.slug}`);
        return { ok: true, action: plan.action, id: entry.id, slug: entry.slug, dryRun: true };
      }
      await client.saveStatusPage(entry.slug, config, imgDataUrl, publicGroupList);
      log(`saved status page ${entry.slug}`);
      return {
        ok: true,
        action: plan.action === "add" ? "add_save" : "save",
        id: entry.id,
        slug: entry.slug,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed save status page ${entry.slug}: ${msg}`);
      return { ok: false, action: "save", id: entry.id, slug: entry.slug, error: msg };
    }
  }

  return { ok: false, action: "unknown", id: entry.id, slug: entry.slug, error: "unknown plan action" };
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {ConfigStatusPage[]} statusPages
 * @param {Awaited<ReturnType<import('./uptime-kuma-status-page-collect.mjs').fetchLiveUptimeKumaStatusPages>>} live
 * @param {import('./uptime-kuma-config.mjs').ConfigMonitor[]} configMonitors
 * @param {import('./uptime-kuma-config.mjs').LiveMonitor[]} liveMonitors
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} opts
 */
export async function syncUptimeKumaStatusPages(client, statusPages, live, configMonitors, liveMonitors, opts = {}) {
  const log = opts.log ?? (() => {});
  const dryRun = Boolean(opts.dryRun);

  const selected = statusPages.filter((p) => p.managed);
  const liveBySlug = new Map(live.statusPages.map((p) => [p.slug.toLowerCase(), p]));

  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const entry of selected) {
    const liveRow = liveBySlug.get(entry.slug.toLowerCase()) ?? null;
    const plan = planStatusPageSync({ entry, live: liveRow });
    log(`status page ${entry.id}: plan action=${plan.action}`);
    const result = await applyStatusPageSync(client, plan, entry, configMonitors, liveMonitors, { dryRun, log });
    results.push(result);
  }

  const ok = results.every((r) => r.ok !== false);
  return { ok, results };
}
