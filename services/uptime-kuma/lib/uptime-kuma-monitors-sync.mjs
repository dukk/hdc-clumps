import {
  findLiveMonitor,
  groupMonitorToSocketPayload,
  monitorHasDrift,
  monitorToSocketPayload,
  parseUptimeKumaId,
} from "./uptime-kuma-config.mjs";

/**
 * @typedef {import('./uptime-kuma-config.mjs').ConfigMonitor} ConfigMonitor
 * @typedef {import('./uptime-kuma-config.mjs').LiveMonitor} LiveMonitor
 * @typedef {import('./uptime-kuma-config.mjs').ConfigTag} ConfigTag
 */

/**
 * @param {object} opts
 * @param {ConfigMonitor} opts.entry
 * @param {LiveMonitor | null} opts.live
 */
export function planMonitorSync(opts) {
  const { entry, live } = opts;

  if (!entry.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      id: entry.id,
      uptime_kuma_id: live?.uptime_kuma_id ?? null,
      reason: "not managed",
      unchanged: true,
    };
  }

  if (!live) {
    return {
      action: /** @type {"add"} */ ("add"),
      id: entry.id,
      uptime_kuma_id: null,
      unchanged: false,
    };
  }

  if (entry.type !== live.type) {
    return {
      action: /** @type {"type_mismatch"} */ ("type_mismatch"),
      id: entry.id,
      uptime_kuma_id: live.uptime_kuma_id,
      config_type: entry.type,
      live_type: live.type,
      unchanged: false,
    };
  }

  if (monitorHasDrift(entry, live)) {
    return {
      action: /** @type {"edit"} */ ("edit"),
      id: entry.id,
      uptime_kuma_id: live.uptime_kuma_id,
      unchanged: false,
    };
  }

  return {
    action: /** @type {"unchanged"} */ ("unchanged"),
    id: entry.id,
    uptime_kuma_id: live.uptime_kuma_id,
    unchanged: true,
  };
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {ReturnType<typeof planMonitorSync>} plan
 * @param {ConfigMonitor} entry
 * @param {{ dryRun?: boolean; log?: (line: string) => void; parentId?: number | null; liveId?: number | null; notificationIDList?: Record<string, boolean> }} [opts]
 */
export async function applyMonitorSync(client, plan, entry, opts = {}) {
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
    return {
      ok: true,
      action: "unchanged",
      id: entry.id,
      uptime_kuma_id: plan.uptime_kuma_id,
    };
  }

  if (plan.action === "add") {
    try {
      if (dryRun) {
        log(`dry-run: would add monitor ${entry.id} (${entry.name})`);
        return { ok: true, action: "add", id: entry.id, dryRun: true };
      }
      const payload = monitorToSocketPayload(entry, false, {
        parentId: opts.parentId ?? null,
        notificationIDList: opts.notificationIDList,
      });
      const resp = await client.addMonitor(payload);
      const newId = resp.monitorID ?? resp.monitorId ?? null;
      log(`added monitor ${entry.id} (uptime_kuma_id=${newId ?? "unknown"})`);
      return { ok: true, action: "add", id: entry.id, uptime_kuma_id: newId };
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
      const liveId = opts.liveId ?? plan.uptime_kuma_id;
      const payload = monitorToSocketPayload(entry, true, {
        parentId: opts.parentId ?? null,
        liveId,
        notificationIDList: opts.notificationIDList,
      });
      await client.editMonitor(payload);
      log(`updated monitor ${entry.id}`);
      return {
        ok: true,
        action: "edit",
        id: entry.id,
        uptime_kuma_id: liveId,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed edit monitor ${entry.id}: ${msg}`);
      return { ok: false, action: "edit", id: entry.id, error: msg };
    }
  }

  return { ok: false, action: "unknown", id: entry.id, error: "unknown plan action" };
}

/**
 * @param {object} opts
 * @param {number} opts.uptimeKumaId
 * @param {boolean} opts.managed
 */
export function planMonitorDelete(opts) {
  if (!opts.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      uptime_kuma_id: opts.uptimeKumaId,
      reason: "no managed monitors in config",
    };
  }
  return {
    action: /** @type {"delete"} */ ("delete"),
    uptime_kuma_id: opts.uptimeKumaId,
  };
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {ReturnType<typeof planMonitorDelete>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void; name?: string }} [opts]
 */
export async function applyMonitorDelete(client, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    return { ok: true, action: "skip", uptime_kuma_id: plan.uptime_kuma_id };
  }

  try {
    if (dryRun) {
      log(`dry-run: would delete monitor uptime_kuma_id=${plan.uptime_kuma_id}`);
      return { ok: true, action: "delete", uptime_kuma_id: plan.uptime_kuma_id, dryRun: true };
    }
    await client.deleteMonitor(plan.uptime_kuma_id);
    log(`deleted monitor uptime_kuma_id=${plan.uptime_kuma_id}${opts.name ? ` (${opts.name})` : ""}`);
    return { ok: true, action: "delete", uptime_kuma_id: plan.uptime_kuma_id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`failed delete monitor ${plan.uptime_kuma_id}: ${msg}`);
    return { ok: false, action: "delete", uptime_kuma_id: plan.uptime_kuma_id, error: msg };
  }
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {ConfigMonitor[]} monitors
 * @param {Awaited<ReturnType<import('./uptime-kuma-collect.mjs').fetchLiveUptimeKumaMonitors>>} live
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} opts
 */
async function ensureGroupMonitors(client, monitors, live, opts) {
  const log = opts.log ?? (() => {});
  const dryRun = Boolean(opts.dryRun);

  const groupNames = [
    ...new Set(
      monitors.filter((m) => m.managed && m.group).map((m) => /** @type {string} */ (m.group)),
    ),
  ];

  /** @type {Map<string, number>} */
  const cache = new Map();

  const liveGroupByName = new Map(
    live.raw.monitorRows
      .filter((r) => r.type === "group")
      .map((r) => {
        const id = parseUptimeKumaId(r.id);
        return [String(r.name ?? "").trim().toLowerCase(), id];
      })
      .filter(([, id]) => id != null),
  );

  for (const name of groupNames) {
    const key = name.toLowerCase();
    let groupId = liveGroupByName.get(key) ?? cache.get(name) ?? null;

    if (groupId == null) {
      if (dryRun) {
        log(`dry-run: would create group monitor "${name}"`);
        cache.set(name, -1);
        continue;
      }
      try {
        const resp = await client.addMonitor(groupMonitorToSocketPayload(name));
        groupId = parseUptimeKumaId(resp.monitorID ?? resp.monitorId);
        if (groupId != null) {
          log(`created group monitor "${name}" (uptime_kuma_id=${groupId})`);
          liveGroupByName.set(key, groupId);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`failed create group "${name}": ${msg}`);
      }
    } else if (!dryRun) {
      try {
        await client.editMonitor(groupMonitorToSocketPayload(name, true, groupId));
        log(`synced group monitor "${name}" (notifications disabled)`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`failed sync group "${name}": ${msg}`);
      }
    } else {
      log(`dry-run: would sync group monitor "${name}" (notifications disabled)`);
    }

    if (groupId != null && groupId > 0) {
      cache.set(name, groupId);
    }
  }

  return cache;
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {ConfigTag[]} tagCatalog
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} opts
 */
async function ensureTags(client, tagCatalog, opts) {
  const log = opts.log ?? (() => {});
  const dryRun = Boolean(opts.dryRun);

  /** @type {Map<string, number>} */
  const byName = new Map();

  if (!dryRun) {
    const liveTags = await client.getTags();
    for (const tag of liveTags) {
      if (typeof tag.name === "string" && tag.name.trim()) {
        const id = parseUptimeKumaId(tag.id);
        if (id != null) byName.set(tag.name.trim().toLowerCase(), id);
      }
    }
  }

  for (const tag of tagCatalog) {
    const key = tag.name.toLowerCase();
    if (byName.has(key)) continue;
    if (dryRun) {
      log(`dry-run: would create tag "${tag.name}"`);
      continue;
    }
    try {
      const created = await client.addTag({
        name: tag.name,
        color: tag.color ?? "#2563eb",
      });
      const id = parseUptimeKumaId(created.id);
      if (id != null) {
        byName.set(key, id);
        log(`created tag "${tag.name}" (id=${id})`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed create tag "${tag.name}": ${msg}`);
    }
  }

  return byName;
}

/** @param {Map<string, number>} tagIdsByName */
function buildTagIdToName(tagIdsByName) {
  /** @type {Map<number, string>} */
  const map = new Map();
  for (const [name, id] of tagIdsByName.entries()) {
    if (id != null && id > 0) map.set(id, name);
  }
  return map;
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @param {Map<number, string>} tagIdToName
 * @returns {{ tagId: number; name: string; value: string }[]}
 */
export function tagAssignmentsFromMonitorRow(row, tagIdToName) {
  if (!row || !Array.isArray(row.tags)) return [];
  /** @type {{ tagId: number; name: string; value: string }[]} */
  const assignments = [];
  for (const t of row.tags) {
    if (t === null || typeof t !== "object") continue;
    const tagId = parseUptimeKumaId(/** @type {Record<string, unknown>} */ (t).tag_id ?? /** @type {Record<string, unknown>} */ (t).tagId);
    if (tagId == null || tagId <= 0) continue;
    const value =
      typeof /** @type {Record<string, unknown>} */ (t).value === "string"
        ? /** @type {Record<string, unknown>} */ (t).value
        : "";
    const nameFromRow =
      typeof /** @type {Record<string, unknown>} */ (t).name === "string"
        ? String(/** @type {Record<string, unknown>} */ (t).name).trim().toLowerCase()
        : "";
    const name = nameFromRow || tagIdToName.get(tagId) || "";
    if (!name) continue;
    assignments.push({ tagId, name, value });
  }
  return assignments;
}

/**
 * Tag names that would remain on a monitor after prune (first assignment per desired name).
 * @param {Record<string, unknown> | null | undefined} rawRow
 * @param {Map<number, string>} tagIdToName
 * @param {string[]} configTagNames
 */
export function liveTagNamesAfterPrune(rawRow, tagIdToName, configTagNames) {
  const desired = new Set(
    configTagNames
      .filter((t) => typeof t === "string" && t.trim())
      .map((t) => String(t).trim().toLowerCase()),
  );
  const assignments = tagAssignmentsFromMonitorRow(rawRow, tagIdToName);
  /** @type {Set<string>} */
  const kept = new Set();
  /** @type {string[]} */
  const names = [];
  for (const assignment of assignments) {
    if (!desired.has(assignment.name)) continue;
    if (kept.has(assignment.name)) continue;
    kept.add(assignment.name);
    names.push(assignment.name);
  }
  return names;
}

/**
 * @param {string[] | undefined | null} liveTagNames
 */
function liveTagNameSet(liveTagNames) {
  return new Set(
    (liveTagNames ?? [])
      .filter((t) => typeof t === "string" && t.trim())
      .map((t) => String(t).trim().toLowerCase()),
  );
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {ConfigMonitor} entry
 * @param {number | null | undefined} monitorId
 * @param {Map<string, number>} tagIdsByName
 * @param {{ dryRun?: boolean; log?: (line: string) => void; liveTagNames?: string[] }} opts
 */
export async function applyMonitorTags(client, entry, monitorId, tagIdsByName, opts = {}) {
  const log = opts.log ?? (() => {});
  const dryRun = Boolean(opts.dryRun);

  if (!monitorId || monitorId <= 0 || !entry.tags?.length) return;

  const present = liveTagNameSet(opts.liveTagNames);

  for (const tagName of entry.tags) {
    const key = tagName.toLowerCase();
    if (present.has(key)) {
      log(`skip tag "${tagName}" on ${entry.id}: already on monitor`);
      continue;
    }
    const tagId = tagIdsByName.get(key);
    if (!tagId || tagId <= 0) {
      log(`skip tag "${tagName}" on ${entry.id}: tag not found in Uptime Kuma`);
      continue;
    }
    if (dryRun) {
      log(`dry-run: would apply tag "${tagName}" to monitor ${entry.id}`);
      present.add(key);
      continue;
    }
    try {
      await client.addMonitorTag(tagId, monitorId, "");
      present.add(key);
      log(`applied tag "${tagName}" to monitor ${entry.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed apply tag "${tagName}" to ${entry.id}: ${msg}`);
    }
  }
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {ConfigMonitor} entry
 * @param {number | null | undefined} monitorId
 * @param {Map<string, number>} tagIdsByName
 * @param {{ dryRun?: boolean; log?: (line: string) => void; rawRow?: Record<string, unknown> | null }} opts
 */
export async function pruneMonitorTags(client, entry, monitorId, tagIdsByName, opts = {}) {
  const log = opts.log ?? (() => {});
  const dryRun = Boolean(opts.dryRun);

  if (!monitorId || monitorId <= 0) return;

  const desired = new Set(
    (entry.tags ?? [])
      .filter((t) => typeof t === "string" && t.trim())
      .map((t) => String(t).trim().toLowerCase()),
  );
  const tagIdToName = buildTagIdToName(tagIdsByName);
  const assignments = tagAssignmentsFromMonitorRow(opts.rawRow ?? null, tagIdToName);
  if (!assignments.length) return;

  /** @type {Set<string>} */
  const kept = new Set();

  for (const assignment of assignments) {
    const inConfig = desired.has(assignment.name);
    const duplicate = kept.has(assignment.name);
    const remove = !inConfig || duplicate;
    if (!remove) {
      kept.add(assignment.name);
      continue;
    }
    const reason = !inConfig ? "not in config" : "duplicate";
    if (dryRun) {
      log(
        `dry-run: would remove tag "${assignment.name}" from monitor ${entry.id} (${reason})`,
      );
      continue;
    }
    try {
      await client.deleteMonitorTag(assignment.tagId, monitorId, assignment.value);
      log(`removed tag "${assignment.name}" from monitor ${entry.id} (${reason})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed remove tag "${assignment.name}" from ${entry.id}: ${msg}`);
    }
  }
}

/**
 * @param {ReturnType<import('./uptime-kuma-api.mjs').createUptimeKumaClient>} client
 * @param {ConfigMonitor[]} monitors
 * @param {Awaited<ReturnType<import('./uptime-kuma-collect.mjs').fetchLiveUptimeKumaMonitors>>} live
 * @param {{ dryRun?: boolean; prune?: boolean; monitorFilter?: string | null; tagCatalog?: ConfigTag[]; notificationIDList?: Record<string, boolean>; notificationsByMonitor?: (entry: ConfigMonitor) => Record<string, boolean>; log?: (line: string) => void }} opts
 */
export async function syncUptimeKumaMonitors(client, monitors, live, opts = {}) {
  const log = opts.log ?? (() => {});
  const dryRun = Boolean(opts.dryRun);
  const prune = Boolean(opts.prune);
  const monitorFilter = opts.monitorFilter ?? null;
  const tagCatalog = opts.tagCatalog ?? [];

  let selected = monitors.filter((m) => m.managed);
  if (monitorFilter) {
    const one = monitors.find((m) => m.id === monitorFilter);
    if (!one) throw new Error(`Monitor id not in config: ${monitorFilter}`);
    if (!one.managed) throw new Error(`Monitor is not managed: ${monitorFilter}`);
    selected = [one];
  }

  const groupIdByName = await ensureGroupMonitors(client, selected, live, { dryRun, log });

  const tagIdsByName = await ensureTags(client, tagCatalog, { dryRun, log });

  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const entry of selected) {
    const liveRow = findLiveMonitor(entry, live.monitors);

    const parentId =
      entry.group && groupIdByName.has(entry.group)
        ? groupIdByName.get(entry.group)
        : null;

    const plan = planMonitorSync({ entry, live: liveRow });
    log(`monitor ${entry.id}: plan action=${plan.action}`);
    const notificationIDList =
      opts.notificationsByMonitor?.(entry) ??
      opts.notificationIDList ??
      {};
    const result = await applyMonitorSync(client, plan, entry, {
      dryRun,
      log,
      parentId: parentId && parentId > 0 ? parentId : null,
      liveId: liveRow?.uptime_kuma_id ?? plan.uptime_kuma_id ?? null,
      notificationIDList,
    });

    const monitorId =
      parseUptimeKumaId(result.uptime_kuma_id) ??
      liveRow?.uptime_kuma_id ??
      null;

    const rawRow =
      monitorId != null
        ? live.raw.monitorRows.find((r) => parseUptimeKumaId(r.id) === monitorId) ?? null
        : null;

    if (result.ok && monitorId) {
      const tagIdToName = buildTagIdToName(tagIdsByName);
      if (prune) {
        await pruneMonitorTags(client, entry, monitorId, tagIdsByName, {
          dryRun,
          log,
          rawRow,
        });
      }
      const liveTagNames = prune
        ? liveTagNamesAfterPrune(rawRow, tagIdToName, entry.tags ?? [])
        : (liveRow?.tags ?? []);
      if (entry.tags?.length) {
        await applyMonitorTags(client, entry, monitorId, tagIdsByName, {
          dryRun,
          log,
          liveTagNames,
        });
      }
    }

    results.push(result);
  }

  if (prune) {
    const hasManaged = monitors.some((m) => m.managed);
    for (const liveRow of live.monitors) {
    if (monitors.some((entry) => findLiveMonitor(entry, [liveRow]))) continue;
      const plan = planMonitorDelete({ uptimeKumaId: liveRow.uptime_kuma_id, managed: hasManaged });
      if (plan.action === "skip") continue;
      log(`prune monitor ${liveRow.name} (uptime_kuma_id=${liveRow.uptime_kuma_id})`);
      const result = await applyMonitorDelete(client, plan, {
        dryRun,
        log,
        name: liveRow.name,
      });
      results.push(result);
    }
  }

  const ok = results.every((r) => r.ok !== false);
  return { ok, results };
}
