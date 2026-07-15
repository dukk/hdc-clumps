import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { resolveRepoFilePath } from "hdc/cli/lib/private-repo.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const CONFIG_FILE_KEYS = ["services", "settings", "bookmarks"];

/**
 * @param {Record<string, unknown>} homepage
 */
export function validateHomepageConfigFiles(homepage) {
  const hp = isObject(homepage) ? homepage : {};
  const cf = isObject(hp.config_files) ? hp.config_files : null;
  if (!cf) {
    throw new Error(
      "homepage.config_files is required (services, settings, bookmarks paths relative to package root)",
    );
  }
  for (const key of CONFIG_FILE_KEYS) {
    const p = typeof cf[key] === "string" ? cf[key].trim() : "";
    if (!p) {
      throw new Error(`homepage.config_files.${key} is required`);
    }
  }
}

/**
 * @param {Record<string, unknown>} homepage
 * @returns {{ services: string; settings: string; bookmarks: string; widgets?: string }}
 */
export function homepageConfigFilePaths(homepage) {
  validateHomepageConfigFiles(homepage);
  const cf = /** @type {Record<string, unknown>} */ (homepage.config_files);
  const widgets = typeof cf.widgets === "string" ? cf.widgets.trim() : "";
  return {
    services: String(cf.services).trim(),
    settings: String(cf.settings).trim(),
    bookmarks: String(cf.bookmarks).trim(),
    ...(widgets ? { widgets } : {}),
  };
}

/**
 * @param {string} packageRoot
 * @param {string} relPath
 */
function packageRelToRepoRel(packageRoot, relPath) {
  const root = repoRoot();
  const trimmed = typeof relPath === "string" ? relPath.trim() : "";
  if (!trimmed) {
    throw new Error("config file path is required");
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error(`homepage config path must be relative to package root: ${trimmed}`);
  }
  const abs = join(packageRoot, trimmed);
  return relative(root, abs).replace(/\\/g, "/");
}

/**
 * @param {string} packageRoot
 * @param {string} relPath
 * @param {string} label
 */
function readPackageConfigFile(packageRoot, relPath, label) {
  const repoRel = packageRelToRepoRel(packageRoot, relPath);
  const resolved = resolveRepoFilePath(repoRoot(), repoRel);
  if (!resolved.found) {
    throw new Error(
      `homepage ${label} not found at clumps/services/homepage/${relPath} (checked hdc and hdc-private)`,
    );
  }
  errout.write(`[hdc] homepage: loading ${label} from ${resolved.rel} (${resolved.source})\n`);
  let content = readFileSync(resolved.path, "utf8").replace(/\r\n/g, "\n");
  if (!content.trim()) {
    throw new Error(`homepage ${label} at ${resolved.rel} is empty`);
  }
  return content.endsWith("\n") ? content : `${content}\n`;
}

/**
 * @param {Record<string, unknown>} homepage
 * @param {string} packageRoot absolute path to clumps/services/homepage
 * @returns {{ servicesYaml: string; settingsYaml: string; bookmarksYaml: string; widgetsYaml?: string; config_paths: { services: string; settings: string; bookmarks: string; widgets?: string } }}
 */
export function loadHomepageConfigFiles(homepage, packageRoot) {
  const paths = homepageConfigFilePaths(homepage);
  const loaded = {
    servicesYaml: readPackageConfigFile(packageRoot, paths.services, "services"),
    settingsYaml: readPackageConfigFile(packageRoot, paths.settings, "settings"),
    bookmarksYaml: readPackageConfigFile(packageRoot, paths.bookmarks, "bookmarks"),
    config_paths: paths,
  };
  if (paths.widgets) {
    loaded.widgetsYaml = readPackageConfigFile(packageRoot, paths.widgets, "widgets");
  }
  return loaded;
}
