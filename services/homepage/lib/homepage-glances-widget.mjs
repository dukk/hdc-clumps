import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { normalizeGlancesConfig } from "../../glances/lib/deployments.mjs";
import { ipFromIpConfig, isObject, serviceUrlFromPublicUrlOrHostPort, widgetBlockEnabled } from "./homepage-widget-utils.mjs";

/**
 * @param {Record<string, unknown>} homepage
 */
export function glancesWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "glances_widget");
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.glancesPackageRoot
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageGlancesWidgetEnv(opts) {
  const { homepage, glancesPackageRoot, dryRun = false } = opts;
  if (!glancesWidgetEnabled(homepage)) return null;

  errout.write("[hdc] homepage: resolving Glances widget env from glances config …\n");

  const loaded = loadClumpConfigFromClumpRoot(glancesPackageRoot, {
    exampleRel: "clumps/services/glances/config.example.json",
  });
  const { defaults, deployments } = normalizeGlancesConfig(loaded.data);
  const deployment = deployments[0];
  if (!deployment) {
    throw new Error("homepage glances_widget: no glances deployments in config");
  }

  const defaultGlances = isObject(defaults.glances) ? defaults.glances : {};
  const deployGlances = isObject(deployment.glances) ? deployment.glances : {};
  const merged = { ...defaultGlances, ...deployGlances };
  const portRaw = typeof merged.host_port === "number" ? merged.host_port : Number(merged.host_port);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 61208;

  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const ipConfig = typeof lxc.ip_config === "string" ? lxc.ip_config : "";
  const ip = ipFromIpConfig(ipConfig);
  const url = serviceUrlFromPublicUrlOrHostPort(
    typeof merged.public_url === "string" ? merged.public_url : "",
    ip ?? "",
    port,
  );
  if (!url) {
    throw new Error(
      `homepage glances_widget: static proxmox.lxc.ip_config required (got ${JSON.stringify(ipConfig || null)})`,
    );
  }

  if (dryRun) {
    return { lines: [`# dry-run: would inject HOMEPAGE_VAR_GLANCES_URL=${url}`], url };
  }

  errout.write(`[hdc] homepage: Glances widget env ready (${url}).\n`);

  return {
    lines: [`HOMEPAGE_VAR_GLANCES_URL=${url}`],
    url,
  };
}
