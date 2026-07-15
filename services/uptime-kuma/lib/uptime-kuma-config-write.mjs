import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HDC_INCLUDE_KEY } from "hdc/cli/lib/json-config-preprocess.mjs";
import {
  formatRepoJson,
  writeResolvedRepoJson,
} from "hdc/cli/lib/private-repo.mjs";

export const UPTIME_KUMA_MONITORS_DIR = "monitors";
export const UPTIME_KUMA_STATUS_PAGES_DIR = "status_pages";

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
 * Read raw config.json and detect split layout via $hdc.include in monitors/status_pages.
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 */
export function usesSplitUptimeKumaLayout(resolved) {
  if (!resolved?.found || !existsSync(resolved.path)) {
    return false;
  }
  try {
    const raw = JSON.parse(readFileSync(resolved.path, "utf8"));
    if (!isObject(raw)) {
      return false;
    }
    return (
      arrayUsesIncludeDirectives(raw.monitors) || arrayUsesIncludeDirectives(raw.status_pages)
    );
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {Set<string>} keepIds
 */
function removeOrphanJsonFiles(dir, keepIds) {
  if (!existsSync(dir)) {
    return;
  }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
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
 * @param {string} configDir
 * @param {string} subdir
 * @param {string} id
 */
function sidecarIncludeRel(subdir, id) {
  return `${subdir}/${id}.json`;
}

/**
 * @param {unknown[]} items
 * @param {(item: Record<string, unknown>) => string} idFromItem
 */
function sortById(items, idFromItem) {
  return [...items].sort((a, b) => {
    const idA = idFromItem(/** @type {Record<string, unknown>} */ (a));
    const idB = idFromItem(/** @type {Record<string, unknown>} */ (b));
    return idA.localeCompare(idB);
  });
}

/**
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 * @param {Record<string, unknown>} data
 * @param {{ compactArrayKeys?: string[] }} [opts]
 */
function writeSplitUptimeKumaConfig(resolved, data, opts = {}) {
  const configDir = dirname(resolved.path);
  const monitorsDir = join(configDir, UPTIME_KUMA_MONITORS_DIR);
  const statusPagesDir = join(configDir, UPTIME_KUMA_STATUS_PAGES_DIR);
  mkdirSync(monitorsDir, { recursive: true });
  mkdirSync(statusPagesDir, { recursive: true });

  const monitors = Array.isArray(data.monitors) ? data.monitors : [];
  const statusPages = Array.isArray(data.status_pages) ? data.status_pages : [];

  const sortedMonitors = sortById(
    monitors.filter((m) => isObject(m) && typeof m.id === "string"),
    (m) => String(m.id),
  );
  const sortedStatusPages = sortById(
    statusPages.filter((p) => isObject(p) && typeof p.id === "string"),
    (p) => String(p.id),
  );

  const monitorIds = new Set();
  for (const monitor of sortedMonitors) {
    const id = String(monitor.id);
    monitorIds.add(id);
    writeFileSync(
      sidecarPath(configDir, UPTIME_KUMA_MONITORS_DIR, id),
      formatRepoJson(monitor, opts),
      "utf8",
    );
  }

  const statusPageIds = new Set();
  for (const page of sortedStatusPages) {
    const id = String(page.id);
    statusPageIds.add(id);
    writeFileSync(
      sidecarPath(configDir, UPTIME_KUMA_STATUS_PAGES_DIR, id),
      formatRepoJson(page, opts),
      "utf8",
    );
  }

  removeOrphanJsonFiles(monitorsDir, monitorIds);
  removeOrphanJsonFiles(statusPagesDir, statusPageIds);

  const root = {
    ...data,
    monitors: sortedMonitors.map((m) => ({
      [HDC_INCLUDE_KEY]: sidecarIncludeRel(UPTIME_KUMA_MONITORS_DIR, String(m.id)),
    })),
    status_pages: sortedStatusPages.map((p) => ({
      [HDC_INCLUDE_KEY]: sidecarIncludeRel(UPTIME_KUMA_STATUS_PAGES_DIR, String(p.id)),
    })),
  };

  writeResolvedRepoJson(resolved, root, opts);
}

/**
 * Write uptime-kuma config; preserves split layout when detected on disk.
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 * @param {Record<string, unknown>} data
 * @param {{ compactArrayKeys?: string[]; split?: boolean }} [opts]
 */
export function writeUptimeKumaConfig(resolved, data, opts = {}) {
  const split =
    opts.split === true || (opts.split !== false && usesSplitUptimeKumaLayout(resolved));

  if (split) {
    writeSplitUptimeKumaConfig(resolved, data, opts);
    return { layout: "split" };
  }

  writeResolvedRepoJson(resolved, data, opts);
  return { layout: "flat" };
}

/**
 * One-time migration: split inline monitors/status_pages into sidecar files.
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 * @param {{ compactArrayKeys?: string[] }} [opts]
 */
export function migrateUptimeKumaConfigToSplitLayout(resolved, opts = {}) {
  const raw = JSON.parse(readFileSync(resolved.path, "utf8"));
  if (!isObject(raw)) {
    throw new Error("config must be a JSON object");
  }
  writeSplitUptimeKumaConfig(resolved, /** @type {Record<string, unknown>} */ (raw), opts);
  return { layout: "split" };
}
