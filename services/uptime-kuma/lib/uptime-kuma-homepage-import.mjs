import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { resolveRepoFilePath } from "hdc/cli/lib/private-repo.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { homepageConfigFilePaths } from "../../homepage/lib/homepage-config-load.mjs";
import { parseHomepageServicesYaml } from "../../homepage/lib/homepage-services-parse.mjs";
import {
  resolveMonitorRetryFields,
  shouldIgnoreTlsForUrl,
  slugifyMonitorId,
} from "./uptime-kuma-config.mjs";

const HOMEPAGE_PACKAGE_EXAMPLE = "clumps/services/homepage/config.example.json";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} serviceName
 */
export function serviceNameToMonitorId(serviceName) {
  return slugifyMonitorId(serviceName);
}

/**
 * @param {string} serviceName
 */
export function shouldSkipHomepageService(serviceName) {
  const id = serviceNameToMonitorId(serviceName);
  return id === "uptime-kuma";
}

/**
 * @param {import("../../homepage/lib/homepage-services-parse.mjs").ParsedHomepageService} service
 * @param {string} groupName
 */
export function homepageServiceToMonitor(service, groupName) {
  if (shouldSkipHomepageService(service.name)) return null;

  const siteMonitor =
    typeof service.siteMonitor === "string" && service.siteMonitor.trim()
      ? service.siteMonitor.trim()
      : null;
  const ping = typeof service.ping === "string" && service.ping.trim() ? service.ping.trim() : null;

  if (!siteMonitor && !ping) return null;

  const id = serviceNameToMonitorId(service.name);
  const group = groupName.trim() || null;

  if (siteMonitor) {
    return {
      id,
      name: service.name,
      type: "http",
      url: siteMonitor,
      hostname: null,
      group,
      tags: [],
      interval: 60,
      ...resolveMonitorRetryFields({}),
      ignore_tls: shouldIgnoreTlsForUrl(siteMonitor),
      managed: true,
      notes: typeof service.description === "string" ? service.description : null,
    };
  }

  return {
    id,
    name: service.name,
    type: "ping",
    url: null,
    hostname: ping,
    group,
    tags: [],
    interval: 60,
    ...resolveMonitorRetryFields({}),
    ignore_tls: false,
    managed: true,
    notes: typeof service.description === "string" ? service.description : null,
  };
}

/**
 * @param {string} servicesYamlText
 */
export function monitorsFromHomepageServicesYaml(servicesYamlText) {
  const groups = parseHomepageServicesYaml(servicesYamlText);
  /** @type {ReturnType<typeof homepageServiceToMonitor>[]} */
  const monitors = [];
  const usedIds = new Set();

  for (const group of groups) {
    for (const service of group.services) {
      const monitor = homepageServiceToMonitor(service, group.name);
      if (!monitor) continue;
      let candidateId = monitor.id;
      let n = 2;
      while (usedIds.has(candidateId)) {
        candidateId = `${monitor.id}-${n}`;
        n += 1;
      }
      monitor.id = candidateId;
      usedIds.add(candidateId);
      monitors.push(monitor);
    }
  }

  return monitors.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {string} root
 */
export function loadHomepageServicesYamlText(root) {
  const homepageRoot = join(root, "clumps", "services", "homepage");
  const loaded = loadClumpConfigFromClumpRoot(homepageRoot, {
    exampleRel: HOMEPAGE_PACKAGE_EXAMPLE,
  });
  const defaults = isObject(loaded.data.defaults) ? loaded.data.defaults : {};
  const hp = isObject(defaults.homepage) ? defaults.homepage : null;

  if (!hp) {
    throw new Error("homepage config missing defaults.homepage block");
  }

  const paths = homepageConfigFilePaths(hp);
  const repoRel = join("packages", "services", "homepage", paths.services).replace(/\\/g, "/");
  const resolved = resolveRepoFilePath(root, repoRel);
  if (!resolved.found) {
    throw new Error(`homepage services.yaml not found at ${repoRel}`);
  }
  errout.write(`[hdc] uptime-kuma: loading homepage services from ${resolved.rel}\n`);
  return readFileSync(resolved.path, "utf8");
}

/**
 * @param {ReturnType<typeof monitorsFromHomepageServicesYaml>} imported
 * @param {unknown[]} existingMonitors
 */
export function mergeHomepageMonitorsIntoConfig(imported, existingMonitors) {
  const existingById = new Map(
    (Array.isArray(existingMonitors) ? existingMonitors : [])
      .filter((m) => isObject(m) && typeof m.id === "string")
      .map((m) => [String(m.id), m]),
  );

  return imported.map((entry) => {
    const existing = existingById.get(entry.id);
    if (!existing || !isObject(existing)) return entry;
    return {
      ...entry,
      managed: existing.managed === false ? false : true,
      notes: typeof existing.notes === "string" ? existing.notes : entry.notes,
      interval: Number(existing.interval ?? entry.interval) || entry.interval,
      ignore_tls: existing.ignore_tls === true ? true : entry.ignore_tls,
      url: typeof existing.url === "string" && existing.url.trim() ? existing.url.trim() : entry.url,
      hostname:
        typeof existing.hostname === "string" && existing.hostname.trim()
          ? existing.hostname.trim()
          : entry.hostname,
    };
  });
}

/**
 * @param {string} [root]
 */
export function importMonitorsFromHomepage(root = repoRoot()) {
  const yamlText = loadHomepageServicesYamlText(root);
  const imported = monitorsFromHomepageServicesYaml(yamlText);
  return { imported, yamlText };
}
