/**
 * Push managed Home Assistant UI automations via REST.
 *
 * POST /api/config/automation/config/{id} (same shape as the HA UI editor).
 * Only entries with managed: true are upserted.
 */

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @typedef {{ id: string; entity_id?: string; managed?: boolean; config?: unknown }} HaAutomationEntry
 */

/**
 * @typedef {{
 *   id: string;
 *   action: "upsert" | "dry_run" | "skipped";
 *   ok: boolean;
 *   message?: string;
 * }} HaAutomationSyncResult
 */

/**
 * Select automations that should be pushed to HA.
 * @param {unknown} automations
 * @param {{ automationId?: string }} [opts]
 * @returns {HaAutomationEntry[]}
 */
export function selectManagedAutomations(automations, opts = {}) {
  if (!Array.isArray(automations)) return [];
  const filterId =
    typeof opts.automationId === "string" && opts.automationId.trim()
      ? opts.automationId.trim()
      : "";
  /** @type {HaAutomationEntry[]} */
  const out = [];
  for (const raw of automations) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) continue;
    if (raw.managed !== true) continue;
    if (!isObject(raw.config)) continue;
    if (filterId && id !== filterId) continue;
    out.push({
      id,
      entity_id: typeof raw.entity_id === "string" ? raw.entity_id : undefined,
      managed: true,
      config: raw.config,
    });
  }
  return out;
}

/**
 * Build POST body: ensure config.id matches the sidecar id.
 * @param {HaAutomationEntry} entry
 * @returns {Record<string, unknown>}
 */
export function automationConfigBody(entry) {
  const config = isObject(entry.config) ? { ...entry.config } : {};
  config.id = entry.id;
  return config;
}

/**
 * Upsert managed automations to a live Home Assistant instance.
 *
 * @param {object} opts
 * @param {ReturnType<import("./ha-api.mjs").createHaClient>} opts.client
 * @param {unknown} opts.automations from loaded config (includes expanded)
 * @param {boolean} [opts.dryRun=false]
 * @param {string} [opts.automationId] filter to a single id
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ ok: boolean; results: HaAutomationSyncResult[] }>}
 */
export async function syncManagedAutomations(opts) {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const selected = selectManagedAutomations(opts.automations, {
    automationId: opts.automationId,
  });

  if (selected.length === 0) {
    log("no managed automations to sync");
    return { ok: true, results: [] };
  }

  /** @type {HaAutomationSyncResult[]} */
  const results = [];
  let ok = true;

  for (const entry of selected) {
    const body = automationConfigBody(entry);
    const path = `/api/config/automation/config/${encodeURIComponent(entry.id)}`;
    if (dryRun) {
      log(`dry-run: would POST ${path} (${entry.id})`);
      results.push({ id: entry.id, action: "dry_run", ok: true });
      continue;
    }
    try {
      log(`POST ${path} …`);
      await opts.client.post(path, body);
      results.push({ id: entry.id, action: "upsert", ok: true });
    } catch (e) {
      ok = false;
      const message = String(/** @type {Error} */ (e).message || e);
      log(`failed ${entry.id}: ${message}`);
      results.push({ id: entry.id, action: "upsert", ok: false, message });
    }
  }

  return { ok, results };
}
