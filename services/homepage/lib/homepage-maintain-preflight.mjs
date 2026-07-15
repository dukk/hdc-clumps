import { join } from "node:path";
import { stderr as errout } from "node:process";

import { loadHomepageConfigFiles } from "./homepage-config-load.mjs";
import { lintHomepageServicesFromConfig } from "./homepage-services-lint.mjs";

/**
 * @param {Record<string, unknown>} homepage
 * @param {string} packageRoot
 */
export function runHomepageServicesLint(homepage, packageRoot) {
  const loaded = loadHomepageConfigFiles(homepage, packageRoot);
  const result = lintHomepageServicesFromConfig(homepage, loaded.servicesYaml, packageRoot);
  for (const warning of result.warnings) {
    errout.write(`[hdc] homepage lint WARN: ${warning}\n`);
  }
  if (!result.ok) {
    throw new Error(`homepage services.yaml lint failed:\n- ${result.errors.join("\n- ")}`);
  }
  errout.write(`[hdc] homepage lint OK (${result.service_count} service tile(s)).\n`);
  return result;
}

/**
 * @param {string} root repo root from repoRoot()
 */
export function homepageWidgetPackageRoots(root) {
  return {
    proxmoxPackageRoot: join(root, "clumps", "infrastructure", "proxmox"),
    piholePackageRoot: join(root, "clumps", "services", "pi-hole"),
    immichPackageRoot: join(root, "clumps", "services", "immich"),
    glancesPackageRoot: join(root, "clumps", "services", "glances"),
    homeassistantPackageRoot: join(root, "clumps", "services", "homeassistant"),
    audiobookshelfPackageRoot: join(root, "clumps", "services", "audiobookshelf"),
    uptimeKumaPackageRoot: join(root, "clumps", "services", "uptime-kuma"),
    crowdsecPackageRoot: join(root, "clumps", "services", "crowdsec"),
    unifiNetworkPackageRoot: join(root, "clumps", "infrastructure", "unifi-network"),
    synologyNasPackageRoot: join(root, "clumps", "infrastructure", "synology-nas"),
    mailcowPackageRoot: join(root, "clumps", "services", "mailcow"),
    bindPackageRoot: join(root, "clumps", "services", "bind"),
  };
}
