/**
 * MeshCentral device power helpers.
 */

/** @type {ReadonlySet<string>} */
export const POWER_ACTIONS = new Set(["wake", "on", "off", "reset", "sleep"]);

/**
 * @param {string | undefined} action
 * @returns {string}
 */
export function normalizePowerAction(action) {
  const a = String(action || "")
    .trim()
    .toLowerCase();
  if (!POWER_ACTIONS.has(a)) {
    throw new Error(`invalid --power ${JSON.stringify(action)} (use wake|on|off|reset|sleep)`);
  }
  // "on" is an alias for wake (agent WoL / resume).
  return a === "on" ? "wake" : a;
}

/**
 * @param {import("./meshcentral-api.mjs").MeshcentralApiClient} client
 * @param {string[]} nodeIds
 * @param {string} action
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyDevicePower(client, nodeIds, action, opts = {}) {
  const power = normalizePowerAction(action);
  const log = opts.log ?? (() => {});
  if (!nodeIds.length) throw new Error("no node ids for power action");
  if (opts.dryRun) {
    log(`dry-run: would power ${power} on ${nodeIds.length} device(s)`);
    return { ok: true, dry_run: true, action: power, node_ids: nodeIds };
  }
  log(`power ${power} → ${nodeIds.length} device(s) …`);
  const raw = await client.power(nodeIds, power);
  const result = typeof raw.result === "string" ? raw.result : "ok";
  const ok = result === "ok" || result === "OK" || result === "";
  return { ok, action: power, node_ids: nodeIds, result, raw };
}
