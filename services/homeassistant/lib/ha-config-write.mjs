/**
 * Write Home Assistant import snapshot as split sidecars + root $hdc.include.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HDC_INCLUDE_KEY } from "hdc/cli/lib/json-config-preprocess.mjs";
import { formatRepoJson, writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";

export const HA_INTEGRATIONS_DIR = "integrations";
export const HA_AUTOMATIONS_DIR = "automations";
export const HA_SCRIPTS_DIR = "scripts";
export const HA_SCENES_DIR = "scenes";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} item
 */
function isIncludeDirective(item) {
  return isObject(item) && HDC_INCLUDE_KEY in item && Object.keys(item).length === 1;
}

/**
 * @param {unknown} arr
 */
function arrayUsesIncludeDirectives(arr) {
  return Array.isArray(arr) && arr.some((item) => isIncludeDirective(item));
}

/**
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 */
export function usesSplitHomeassistantImportLayout(resolved) {
  if (!resolved?.found || !existsSync(resolved.path)) {
    return false;
  }
  try {
    const raw = JSON.parse(readFileSync(resolved.path, "utf8"));
    if (!isObject(raw)) return false;
    return (
      arrayUsesIncludeDirectives(raw.integrations) ||
      arrayUsesIncludeDirectives(raw.automations) ||
      arrayUsesIncludeDirectives(raw.scripts) ||
      arrayUsesIncludeDirectives(raw.scenes)
    );
  } catch {
    return false;
  }
}

/**
 * Sanitize id for sidecar filename.
 * @param {string} id
 */
export function haSidecarSlug(id) {
  const s = String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "unnamed";
}

/**
 * @param {string} dir
 * @param {Set<string>} keepIds
 */
function removeOrphanJsonFiles(dir, keepIds) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!keepIds.has(id)) {
      unlinkSync(join(dir, name));
    }
  }
}

/**
 * @param {string} configDir
 * @param {string} subdir
 * @param {string} id
 */
function sidecarPath(configDir, subdir, id) {
  return join(configDir, subdir, `${id}.json`);
}

/**
 * @param {string} subdir
 * @param {string} id
 */
function sidecarIncludeRel(subdir, id) {
  return `${subdir}/${id}.json`;
}

/**
 * Ensure unique slugs when ids collide after sanitization.
 * @param {string[]} ids
 * @returns {Map<string, string>} original id → slug
 */
export function uniqueSlugsForIds(ids) {
  /** @type {Map<string, string>} */
  const map = new Map();
  /** @type {Set<string>} */
  const used = new Set();
  for (const id of ids) {
    let slug = haSidecarSlug(id);
    if (used.has(slug)) {
      let n = 2;
      while (used.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    used.add(slug);
    map.set(id, slug);
  }
  return map;
}

/**
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 * @param {Record<string, unknown>} data
 * @param {{ compactArrayKeys?: string[] }} [opts]
 */
function writeSplitHomeassistantConfig(resolved, data, opts = {}) {
  const configDir = dirname(resolved.path);
  const integrationsDir = join(configDir, HA_INTEGRATIONS_DIR);
  const automationsDir = join(configDir, HA_AUTOMATIONS_DIR);
  const scriptsDir = join(configDir, HA_SCRIPTS_DIR);
  const scenesDir = join(configDir, HA_SCENES_DIR);
  mkdirSync(integrationsDir, { recursive: true });
  mkdirSync(automationsDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(scenesDir, { recursive: true });

  const integrations = Array.isArray(data.integrations)
    ? data.integrations.filter((m) => isObject(m) && typeof m.id === "string")
    : [];
  const automations = Array.isArray(data.automations)
    ? data.automations.filter((m) => isObject(m) && typeof m.id === "string")
    : [];
  const scripts = Array.isArray(data.scripts)
    ? data.scripts.filter((m) => isObject(m) && typeof m.id === "string")
    : [];
  const scenes = Array.isArray(data.scenes)
    ? data.scenes.filter((m) => isObject(m) && typeof m.id === "string")
    : [];

  const integSlugs = uniqueSlugsForIds(integrations.map((i) => String(i.id)));
  const autoSlugs = uniqueSlugsForIds(automations.map((i) => String(i.id)));
  const scriptSlugs = uniqueSlugsForIds(scripts.map((i) => String(i.id)));
  const sceneSlugs = uniqueSlugsForIds(scenes.map((i) => String(i.id)));

  /** @type {Set<string>} */
  const integKeep = new Set();
  for (const item of integrations) {
    const slug = integSlugs.get(String(item.id));
    if (!slug) continue;
    integKeep.add(slug);
    const body = { ...item, id: slug };
    writeFileSync(sidecarPath(configDir, HA_INTEGRATIONS_DIR, slug), formatRepoJson(body, opts), "utf8");
  }

  /** @type {Set<string>} */
  const autoKeep = new Set();
  for (const item of automations) {
    const slug = autoSlugs.get(String(item.id));
    if (!slug) continue;
    autoKeep.add(slug);
    const body = { ...item, id: slug };
    writeFileSync(sidecarPath(configDir, HA_AUTOMATIONS_DIR, slug), formatRepoJson(body, opts), "utf8");
  }

  /** @type {Set<string>} */
  const scriptKeep = new Set();
  for (const item of scripts) {
    const slug = scriptSlugs.get(String(item.id));
    if (!slug) continue;
    scriptKeep.add(slug);
    const body = { ...item, id: slug };
    writeFileSync(sidecarPath(configDir, HA_SCRIPTS_DIR, slug), formatRepoJson(body, opts), "utf8");
  }

  /** @type {Set<string>} */
  const sceneKeep = new Set();
  for (const item of scenes) {
    const slug = sceneSlugs.get(String(item.id));
    if (!slug) continue;
    sceneKeep.add(slug);
    const body = { ...item, id: slug };
    writeFileSync(sidecarPath(configDir, HA_SCENES_DIR, slug), formatRepoJson(body, opts), "utf8");
  }

  removeOrphanJsonFiles(integrationsDir, integKeep);
  removeOrphanJsonFiles(automationsDir, autoKeep);
  removeOrphanJsonFiles(scriptsDir, scriptKeep);
  removeOrphanJsonFiles(scenesDir, sceneKeep);

  const sortedInteg = [...integKeep].sort((a, b) => a.localeCompare(b));
  const sortedAuto = [...autoKeep].sort((a, b) => a.localeCompare(b));
  const sortedScripts = [...scriptKeep].sort((a, b) => a.localeCompare(b));
  const sortedScenes = [...sceneKeep].sort((a, b) => a.localeCompare(b));

  const root = {
    ...data,
    integrations: sortedInteg.map((id) => ({
      [HDC_INCLUDE_KEY]: sidecarIncludeRel(HA_INTEGRATIONS_DIR, id),
    })),
    automations: sortedAuto.map((id) => ({
      [HDC_INCLUDE_KEY]: sidecarIncludeRel(HA_AUTOMATIONS_DIR, id),
    })),
    scripts: sortedScripts.map((id) => ({
      [HDC_INCLUDE_KEY]: sidecarIncludeRel(HA_SCRIPTS_DIR, id),
    })),
    scenes: sortedScenes.map((id) => ({
      [HDC_INCLUDE_KEY]: sidecarIncludeRel(HA_SCENES_DIR, id),
    })),
  };

  writeResolvedRepoJson(resolved, root, opts);
}

/**
 * Write homeassistant config; force split for import arrays.
 *
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 * @param {Record<string, unknown>} data
 * @param {{ compactArrayKeys?: string[]; split?: boolean }} [opts]
 */
export function writeHomeassistantConfig(resolved, data, opts = {}) {
  const split =
    opts.split === true ||
    (opts.split !== false && usesSplitHomeassistantImportLayout(resolved)) ||
    Array.isArray(data.integrations) ||
    Array.isArray(data.automations) ||
    Array.isArray(data.scripts) ||
    Array.isArray(data.scenes);

  if (split) {
    writeSplitHomeassistantConfig(resolved, data, opts);
    return { layout: "split" };
  }

  writeResolvedRepoJson(resolved, data, opts);
  return { layout: "flat" };
}
