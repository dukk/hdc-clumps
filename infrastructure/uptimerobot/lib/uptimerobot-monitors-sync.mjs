import { monitorHasDrift, monitorToApiFields } from "./uptimerobot-config.mjs";

/**
 * @typedef {import('./uptimerobot-config.mjs').ConfigMonitor} ConfigMonitor
 */

/**
 * @param {object} opts
 * @param {ConfigMonitor} opts.entry
 * @param {ConfigMonitor | null} opts.live
 */
export function planMonitorSync(opts) {
  const { entry, live } = opts;

  if (!entry.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      id: entry.id,
      uptimerobot_id: entry.uptimerobot_id,
      reason: "not managed",
      unchanged: true,
    };
  }

  if (!live) {
    return {
      action: /** @type {"add"} */ ("add"),
      id: entry.id,
      uptimerobot_id: null,
      unchanged: false,
    };
  }

  if (entry.type !== live.type) {
    return {
      action: /** @type {"type_mismatch"} */ ("type_mismatch"),
      id: entry.id,
      uptimerobot_id: entry.uptimerobot_id,
      config_type: entry.type,
      live_type: live.type,
      unchanged: false,
    };
  }

  if (monitorHasDrift(entry, live)) {
    return {
      action: /** @type {"edit"} */ ("edit"),
      id: entry.id,
      uptimerobot_id: entry.uptimerobot_id,
      unchanged: false,
    };
  }

  return {
    action: /** @type {"unchanged"} */ ("unchanged"),
    id: entry.id,
    uptimerobot_id: entry.uptimerobot_id,
    unchanged: true,
  };
}

/**
 * @param {ReturnType<import('./uptimerobot-api.mjs').createUptimerobotClient>} api
 * @param {ReturnType<typeof planMonitorSync>} plan
 * @param {ConfigMonitor} entry
 * @param {Map<string, number>} contactUptimerobotIdByHdcId
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyMonitorSync(api, plan, entry, contactUptimerobotIdByHdcId, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip monitor ${entry.id} (${plan.reason})`);
    return { ok: true, action: "skip", id: entry.id };
  }

  if (plan.action === "type_mismatch") {
    const msg = `monitor ${entry.id}: type mismatch (config=${plan.config_type}, live=${plan.live_type}); delete and recreate manually`;
    log(`error: ${msg}`);
    return { ok: false, action: "type_mismatch", id: entry.id, error: msg };
  }

  if (plan.action === "unchanged") {
    log(`unchanged monitor ${entry.id}`);
    return { ok: true, action: "unchanged", id: entry.id };
  }

  if (plan.action === "add") {
    try {
      if (dryRun) {
        log(`dry-run: would add monitor ${entry.id} (${entry.friendly_name})`);
        return { ok: true, action: "add", id: entry.id, dryRun: true };
      }
      const fields = monitorToApiFields(entry, contactUptimerobotIdByHdcId, false);
      const resp = await api.newMonitor(fields);
      const newId = resp.monitor?.id ?? resp.id;
      log(`added monitor ${entry.id} (uptimerobot_id=${newId ?? "unknown"})`);
      return { ok: true, action: "add", id: entry.id, uptimerobot_id: newId ?? null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed add monitor ${entry.id}: ${msg}`);
      return { ok: false, action: "add", id: entry.id, error: msg };
    }
  }

  if (plan.action === "edit") {
    try {
      if (dryRun) {
        log(`dry-run: would edit monitor ${entry.id}`);
        return { ok: true, action: "edit", id: entry.id, dryRun: true };
      }
      const fields = monitorToApiFields(entry, contactUptimerobotIdByHdcId, true);
      await api.editMonitor(fields);
      log(`updated monitor ${entry.id}`);
      return { ok: true, action: "edit", id: entry.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed edit monitor ${entry.id}: ${msg}`);
      return { ok: false, action: "edit", id: entry.id, error: msg };
    }
  }

  return { ok: true, action: "unknown", id: entry.id };
}

/**
 * @param {object} opts
 * @param {number} opts.uptimerobotId
 * @param {string} opts.id
 * @param {boolean} opts.managed
 */
export function planMonitorDelete(opts) {
  if (!opts.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      id: opts.id,
      uptimerobot_id: opts.uptimerobotId,
      reason: "not managed",
    };
  }
  return {
    action: /** @type {"delete"} */ ("delete"),
    id: opts.id,
    uptimerobot_id: opts.uptimerobotId,
  };
}

/**
 * @param {ReturnType<import('./uptimerobot-api.mjs').createUptimerobotClient>} api
 * @param {ReturnType<typeof planMonitorDelete>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyMonitorDelete(api, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip delete monitor ${plan.id} (${plan.reason})`);
    return { ok: true, action: "skip", id: plan.id };
  }

  try {
    if (dryRun) {
      log(`dry-run: would delete monitor ${plan.id} (uptimerobot_id=${plan.uptimerobot_id})`);
      return { ok: true, action: "delete", id: plan.id, dryRun: true };
    }
    await api.deleteMonitor(plan.uptimerobot_id);
    log(`deleted monitor ${plan.id} (uptimerobot_id=${plan.uptimerobot_id})`);
    return { ok: true, action: "delete", id: plan.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`failed delete monitor ${plan.id}: ${msg}`);
    return { ok: false, action: "delete", id: plan.id, error: msg };
  }
}

