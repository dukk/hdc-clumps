import { alertContactHasDrift, alertContactToApiFields } from "./uptimerobot-config.mjs";

/**
 * @typedef {import('./uptimerobot-config.mjs').ConfigAlertContact} ConfigAlertContact
 */

/**
 * @param {object} opts
 * @param {ConfigAlertContact} opts.entry
 * @param {ConfigAlertContact | null} opts.live
 */
export function planAlertContactSync(opts) {
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
    if (!entry.value) {
      return {
        action: /** @type {"skip"} */ ("skip"),
        id: entry.id,
        uptimerobot_id: entry.uptimerobot_id,
        reason: "missing value for new contact",
        unchanged: false,
      };
    }
    return {
      action: /** @type {"add"} */ ("add"),
      id: entry.id,
      uptimerobot_id: null,
      unchanged: false,
    };
  }

  if (!entry.value && live.value) {
    return {
      action: /** @type {"unchanged"} */ ("unchanged"),
      id: entry.id,
      uptimerobot_id: entry.uptimerobot_id,
      reason: "value not in config (import may omit secrets)",
      unchanged: true,
    };
  }

  if (alertContactHasDrift(entry, live)) {
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
 * @param {ReturnType<typeof planAlertContactSync>} plan
 * @param {ConfigAlertContact} entry
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyAlertContactSync(api, plan, entry, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip alert contact ${entry.id} (${plan.reason})`);
    return { ok: true, action: "skip", id: entry.id, reason: plan.reason };
  }

  if (plan.action === "unchanged") {
    log(`unchanged alert contact ${entry.id}`);
    return { ok: true, action: "unchanged", id: entry.id };
  }

  if (plan.action === "add") {
    try {
      if (dryRun) {
        log(`dry-run: would add alert contact ${entry.id}`);
        return { ok: true, action: "add", id: entry.id, dryRun: true };
      }
      const fields = alertContactToApiFields(entry, false);
      const resp = await api.newAlertContact(fields);
      const newId = resp.alertcontact?.id ?? resp.id;
      log(`added alert contact ${entry.id} (uptimerobot_id=${newId ?? "unknown"})`);
      return { ok: true, action: "add", id: entry.id, uptimerobot_id: newId ?? null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed add alert contact ${entry.id}: ${msg}`);
      return { ok: false, action: "add", id: entry.id, error: msg };
    }
  }

  if (plan.action === "edit") {
    try {
      if (dryRun) {
        log(`dry-run: would edit alert contact ${entry.id}`);
        return { ok: true, action: "edit", id: entry.id, dryRun: true };
      }
      const fields = alertContactToApiFields(entry, true);
      if (!fields.value) delete fields.value;
      await api.editAlertContact(fields);
      log(`updated alert contact ${entry.id}`);
      return { ok: true, action: "edit", id: entry.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed edit alert contact ${entry.id}: ${msg}`);
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
export function planAlertContactDelete(opts) {
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
 * @param {ReturnType<typeof planAlertContactDelete>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyAlertContactDelete(api, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip delete alert contact ${plan.id} (${plan.reason})`);
    return { ok: true, action: "skip", id: plan.id };
  }

  try {
    if (dryRun) {
      log(`dry-run: would delete alert contact ${plan.id} (uptimerobot_id=${plan.uptimerobot_id})`);
      return { ok: true, action: "delete", id: plan.id, dryRun: true };
    }
    await api.deleteAlertContact(plan.uptimerobot_id);
    log(`deleted alert contact ${plan.id} (uptimerobot_id=${plan.uptimerobot_id})`);
    return { ok: true, action: "delete", id: plan.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`failed delete alert contact ${plan.id}: ${msg}`);
    return { ok: false, action: "delete", id: plan.id, error: msg };
  }
}
