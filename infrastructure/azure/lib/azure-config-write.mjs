import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HDC_INCLUDE_KEY } from "hdc/cli/lib/json-config-preprocess.mjs";
import {
  formatRepoJson,
  writeResolvedRepoJson,
} from "hdc/cli/lib/private-repo.mjs";

export const AZURE_ENTRA_APPLICATIONS_DIR = "entra/applications";
export const AZURE_COMPUTE_DEPLOYMENTS_DIR = "compute/deployments";

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
export function usesSplitAzureEntraLayout(resolved) {
  if (!resolved?.found || !existsSync(resolved.path)) return false;
  try {
    const raw = JSON.parse(readFileSync(resolved.path, "utf8"));
    if (!isObject(raw)) return false;
    if (isObject(raw.entra) && arrayUsesIncludeDirectives(raw.entra.applications)) return true;
    return arrayUsesIncludeDirectives(raw.applications);
  } catch {
    return false;
  }
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
    if (!keepIds.has(id)) unlinkSync(join(dir, name));
  }
}

/**
 * Write unified azure config; when split, applications go under entra/applications/.
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 * @param {Record<string, unknown>} data
 * @param {{ compactArrayKeys?: string[]; split?: boolean }} [opts]
 */
export function writeAzureConfig(resolved, data, opts = {}) {
  const split =
    opts.split === true || (opts.split !== false && usesSplitAzureEntraLayout(resolved));

  if (!split) {
    writeResolvedRepoJson(resolved, data, opts);
    return { layout: "flat" };
  }

  const configDir = dirname(resolved.path);
  const appsDir = join(configDir, AZURE_ENTRA_APPLICATIONS_DIR);
  mkdirSync(appsDir, { recursive: true });

  const entra = isObject(data.entra) ? { ...data.entra } : {};
  const applications = Array.isArray(entra.applications)
    ? entra.applications
    : Array.isArray(data.applications)
      ? data.applications
      : [];

  const sorted = [...applications]
    .filter((a) => isObject(a) && typeof a.id === "string" && a.id.trim())
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const keepIds = new Set();
  for (const app of sorted) {
    const id = String(app.id);
    keepIds.add(id);
    writeFileSync(join(appsDir, `${id}.json`), formatRepoJson(app, opts), "utf8");
  }
  removeOrphanJsonFiles(appsDir, keepIds);

  const nextEntra = {
    ...entra,
    applications: sorted.map((a) => ({
      [HDC_INCLUDE_KEY]: `${AZURE_ENTRA_APPLICATIONS_DIR}/${a.id}.json`,
    })),
  };

  const root = {
    ...data,
    schema_version: typeof data.schema_version === "number" ? data.schema_version : 2,
    entra: nextEntra,
  };
  delete root.applications;
  delete root.application_filter;
  delete root.azure;
  delete root.azure_entra;

  writeResolvedRepoJson(resolved, root, opts);
  return { layout: "split" };
}
