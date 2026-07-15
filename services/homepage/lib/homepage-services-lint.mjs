import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { repoRoot } from "hdc/cli/paths.mjs";
import { resolveRepoFilePath } from "hdc/cli/lib/private-repo.mjs";
import { widgetBlockEnabled } from "./homepage-widget-utils.mjs";
import { HOMEPAGE_WIDGET_CATALOG, catalogEntryByTileName, catalogEntryByWidgetType } from "./homepage-widget-catalog.mjs";
import { flattenHomepageServices, parseHomepageServicesYaml } from "./homepage-services-parse.mjs";

const ICONS_REL_DIR = "homepage/icons";

/**
 * @param {string} packageRoot
 * @returns {Set<string>}
 */
export function listVendoredIconFilenames(packageRoot) {
  const root = repoRoot();
  const abs = join(packageRoot, ICONS_REL_DIR);
  const repoRel = relative(root, abs).replace(/\\/g, "/");
  const resolved = resolveRepoFilePath(root, repoRel);
  if (!resolved.found) return new Set();

  /** @type {Set<string>} */
  const names = new Set();
  try {
    for (const entry of readdirSync(resolved.path, { withFileTypes: true })) {
      if (entry.isFile() && /\.png$/i.test(entry.name)) names.add(entry.name);
    }
  } catch {
    return names;
  }
  return names;
}

/**
 * @param {string} icon
 * @param {Set<string>} vendoredIcons
 */
function validateIconReference(icon, vendoredIcons) {
  const trimmed = typeof icon === "string" ? icon.trim() : "";
  if (!trimmed) {
    return "missing icon (every service tile requires icon)";
  }
  const customMatch = trimmed.match(/^\/icons\/([^/]+\.png)$/i);
  if (customMatch) {
    const filename = customMatch[1];
    if (!vendoredIcons.has(filename)) {
      return `icon ${JSON.stringify(trimmed)} references missing vendored file homepage/icons/${filename}`;
    }
  }
  return null;
}

/**
 * @param {string} raw
 * @param {string[]} placeholders
 */
function rawContainsPlaceholders(raw, placeholders) {
  for (const ph of placeholders) {
    if (ph.endsWith("_")) {
      if (raw.includes(`{{${ph}`)) return true;
    } else if (raw.includes(`{{${ph}}}`)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.servicesYaml
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.packageRoot absolute path to clumps/services/homepage
 * @returns {{ ok: boolean; errors: string[]; warnings: string[]; service_count: number }}
 */
export function lintHomepageServicesYaml(opts) {
  const { servicesYaml, homepage, packageRoot } = opts;
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const groups = parseHomepageServicesYaml(servicesYaml);
  const services = flattenHomepageServices(groups);
  const vendoredIcons = listVendoredIconFilenames(packageRoot);

  if (services.length === 0) {
    errors.push("services.yaml contains no service tiles");
  }

  for (const svc of services) {
    const iconErr = validateIconReference(svc.icon ?? "", vendoredIcons);
    if (iconErr) {
      errors.push(`${svc.name}: ${iconErr}`);
    }

    const catalog = catalogEntryByTileName(svc.name);
    const widget = svc.widget;
    const widgetType =
      widget && typeof widget.type === "string" ? String(widget.type).trim().toLowerCase() : null;

    if (widgetType) {
      const entry = catalogEntryByWidgetType(widgetType);
      if (!entry) {
        errors.push(`${svc.name}: unknown widget type ${JSON.stringify(widgetType)}`);
      } else if (!widgetBlockEnabled(homepage, entry.configKey)) {
        errors.push(
          `${svc.name}: widget type ${JSON.stringify(widgetType)} present but homepage.${entry.configKey} is not enabled`,
        );
      } else if (!entry.placeholders.length) {
        // customapi BIND widgets use static localhost stats URLs — no env placeholders
      } else if (!rawContainsPlaceholders(svc.raw, entry.placeholders)) {
        errors.push(
          `${svc.name}: widget missing expected env placeholders (${entry.placeholders.join(", ")})`,
        );
      }
    }

    if (catalog && widgetBlockEnabled(homepage, catalog.configKey)) {
      if (!widgetType) {
        errors.push(
          `${svc.name}: homepage.${catalog.configKey} enabled but services.yaml has no widget block (type: ${catalog.widgetType})`,
        );
      } else if (widgetType !== catalog.widgetType) {
        errors.push(
          `${svc.name}: expected widget type ${JSON.stringify(catalog.widgetType)} but got ${JSON.stringify(widgetType)}`,
        );
      }
    }
  }

  for (const entry of HOMEPAGE_WIDGET_CATALOG) {
    if (!widgetBlockEnabled(homepage, entry.configKey)) continue;
    for (const tileName of entry.tileNames) {
      const svc = services.find((s) => s.name === tileName);
      if (!svc) {
        warnings.push(
          `homepage.${entry.configKey} enabled but no tile ${JSON.stringify(tileName)} in services.yaml`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    service_count: services.length,
  };
}

/**
 * @param {string} packageRoot
 * @param {Record<string, unknown>} homepage
 * @param {string} servicesYaml
 */
export function lintHomepageServicesFromConfig(homepage, servicesYaml, packageRoot) {
  return lintHomepageServicesYaml({ servicesYaml, homepage, packageRoot });
}
