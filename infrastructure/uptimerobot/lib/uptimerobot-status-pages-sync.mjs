import { statusPageHasDrift, statusPageToApiFields } from "./uptimerobot-config.mjs";

/**
 * @typedef {import('./uptimerobot-config.mjs').ConfigStatusPage} ConfigStatusPage
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

  if (statusPageHasDrift(entry, live)) {
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
 * @param {ReturnType<typeof planStatusPageSync>} plan
 * @param {ConfigStatusPage} entry
 * @param {Map<string, number>} monitorUptimerobotIdByHdcId
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyStatusPageSync(
  api,
  plan,
  entry,
  monitorUptimerobotIdByHdcId,
  opts = {}
) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip status page ${entry.id} (${plan.reason})`);
    return { ok: true, action: "skip", id: entry.id };
  }

  if (plan.action === "unchanged") {
    log(`unchanged status page ${entry.id}`);
    return { ok: true, action: "unchanged", id: entry.id };
  }

  if (plan.action === "add") {
    try {
      if (dryRun) {
        log(`dry-run: would add status page ${entry.id}`);
        return { ok: true, action: "add", id: entry.id, dryRun: true };
      }
      const fields = statusPageToApiFields(entry, monitorUptimerobotIdByHdcId, false);
      const resp = await api.newPsp(fields);
      const newId = resp.psp?.id ?? resp.id;
      log(`added status page ${entry.id} (uptimerobot_id=${newId ?? "unknown"})`);
      return { ok: true, action: "add", id: entry.id, uptimerobot_id: newId ?? null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed add status page ${entry.id}: ${msg}`);
      return { ok: false, action: "add", id: entry.id, error: msg };
    }
  }

  if (plan.action === "edit") {
    try {
      if (dryRun) {
        log(`dry-run: would edit status page ${entry.id}`);
        return { ok: true, action: "edit", id: entry.id, dryRun: true };
      }
      const fields = statusPageToApiFields(entry, monitorUptimerobotIdByHdcId, true);
      await api.editPsp(fields);
      log(`updated status page ${entry.id}`);
      return { ok: true, action: "edit", id: entry.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed edit status page ${entry.id}: ${msg}`);
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
export function planStatusPageDelete(opts) {
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
 * @param {ReturnType<typeof planStatusPageDelete>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyStatusPageDelete(api, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip delete status page ${plan.id} (${plan.reason})`);
    return { ok: true, action: "skip", id: plan.id };
  }

  try {
    if (dryRun) {
      log(`dry-run: would delete status page ${plan.id} (uptimerobot_id=${plan.uptimerobot_id})`);
      return { ok: true, action: "delete", id: plan.id, dryRun: true };
    }
    await api.deletePsp(plan.uptimerobot_id);
    log(`deleted status page ${plan.id} (uptimerobot_id=${plan.uptimerobot_id})`);
    return { ok: true, action: "delete", id: plan.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`failed delete status page ${plan.id}: ${msg}`);
    return { ok: false, action: "delete", id: plan.id, error: msg };
  }
}
