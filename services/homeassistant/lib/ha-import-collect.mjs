/**
 * Collect live Home Assistant config via REST for import.
 */

import {
  sanitizeConfigEntry,
  sanitizeHaCoreConfig,
  sanitizeHaYamlConfigBody,
} from "./ha-import-sanitize.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} entityId e.g. automation.foo
 * @returns {{ domain: string; objectId: string } | null}
 */
export function splitEntityId(entityId) {
  const s = String(entityId ?? "").trim();
  const i = s.indexOf(".");
  if (i <= 0 || i === s.length - 1) return null;
  return { domain: s.slice(0, i), objectId: s.slice(i + 1) };
}

/**
 * @param {unknown} states
 * @param {string} domain
 * @returns {Array<{ entity_id: string; id: string; attributes: Record<string, unknown> }>}
 */
export function listDomainEntities(states, domain) {
  if (!Array.isArray(states)) return [];
  /** @type {Array<{ entity_id: string; id: string; attributes: Record<string, unknown> }>} */
  const out = [];
  for (const st of states) {
    if (!isObject(st)) continue;
    const entityId = typeof st.entity_id === "string" ? st.entity_id : "";
    const parts = splitEntityId(entityId);
    if (!parts || parts.domain !== domain) continue;
    const attrs = isObject(st.attributes) ? st.attributes : {};
    const idFromAttr =
      typeof attrs.id === "string" && attrs.id.trim()
        ? attrs.id.trim()
        : typeof attrs.id === "number"
          ? String(attrs.id)
          : "";
    const id = idFromAttr || parts.objectId;
    out.push({ entity_id: entityId, id, attributes: attrs });
  }
  return out;
}

/**
 * @param {ReturnType<import("./ha-api.mjs").createHaClient>} client
 * @param {(line: string) => void} [log]
 */
export async function collectHaImportSnapshot(client, log = () => {}) {
  log("GET /api/config …");
  const coreRaw = await client.get("/api/config");
  const core = sanitizeHaCoreConfig(coreRaw);

  log("GET /api/config/config_entries/entry …");
  const entriesRaw = await client.get("/api/config/config_entries/entry");
  const entries = Array.isArray(entriesRaw) ? entriesRaw : [];

  /** @type {Record<string, Record<string, unknown>[]>} */
  const byDomain = {};
  for (const raw of entries) {
    if (!isObject(raw)) continue;
    const domain = typeof raw.domain === "string" ? raw.domain.trim() : "";
    if (!domain) continue;
    const sanitized = sanitizeConfigEntry(raw);
    if (!sanitized) continue;
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(sanitized);
  }

  /** @type {Array<{ id: string; domain: string; entries: Record<string, unknown>[] }>} */
  const integrations = Object.keys(byDomain)
    .sort((a, b) => a.localeCompare(b))
    .map((domain) => ({
      id: domain,
      domain,
      entries: byDomain[domain].sort((a, b) =>
        String(a.title ?? "").localeCompare(String(b.title ?? "")),
      ),
    }));

  log("GET /api/states …");
  const states = await client.get("/api/states");

  const automationEntities = listDomainEntities(states, "automation");
  const scriptEntities = listDomainEntities(states, "script");
  const sceneEntities = listDomainEntities(states, "scene");

  /** @type {Array<{ id: string; entity_id: string; config: unknown }>} */
  const automations = [];
  for (const ent of automationEntities) {
    const configId = ent.id;
    try {
      log(`GET /api/config/automation/config/${configId} …`);
      const body = await client.get(
        `/api/config/automation/config/${encodeURIComponent(configId)}`,
      );
      automations.push({
        id: configId,
        entity_id: ent.entity_id,
        config: sanitizeHaYamlConfigBody(body),
      });
    } catch (e) {
      log(
        `skip automation ${JSON.stringify(ent.entity_id)}: ${String(/** @type {Error} */ (e).message || e)}`,
      );
    }
  }

  /** @type {Array<{ id: string; entity_id: string; config: unknown }>} */
  const scripts = [];
  for (const ent of scriptEntities) {
    const objectId = splitEntityId(ent.entity_id)?.objectId ?? ent.id;
    try {
      log(`GET /api/config/script/config/${objectId} …`);
      const body = await client.get(
        `/api/config/script/config/${encodeURIComponent(objectId)}`,
      );
      scripts.push({
        id: objectId,
        entity_id: ent.entity_id,
        config: sanitizeHaYamlConfigBody(body),
      });
    } catch (e) {
      log(
        `skip script ${JSON.stringify(ent.entity_id)}: ${String(/** @type {Error} */ (e).message || e)}`,
      );
    }
  }

  /** @type {Array<{ id: string; entity_id: string; config: unknown }>} */
  const scenes = [];
  for (const ent of sceneEntities) {
    const configId = ent.id;
    try {
      log(`GET /api/config/scene/config/${configId} …`);
      const body = await client.get(
        `/api/config/scene/config/${encodeURIComponent(configId)}`,
      );
      scenes.push({
        id: configId,
        entity_id: ent.entity_id,
        config: sanitizeHaYamlConfigBody(body),
      });
    } catch (e) {
      log(
        `skip scene ${JSON.stringify(ent.entity_id)}: ${String(/** @type {Error} */ (e).message || e)}`,
      );
    }
  }

  automations.sort((a, b) => a.id.localeCompare(b.id));
  scripts.sort((a, b) => a.id.localeCompare(b.id));
  scenes.sort((a, b) => a.id.localeCompare(b.id));

  const haVersion =
    isObject(coreRaw) && typeof coreRaw.version === "string" ? coreRaw.version : null;

  return {
    ha_version: haVersion,
    core,
    integrations,
    automations,
    scripts,
    scenes,
  };
}
