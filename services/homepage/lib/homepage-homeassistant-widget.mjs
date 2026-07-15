import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import {
  ipFromCidr,
  isObject,
  readRequiredVaultSecret,
  serviceUrlFromHostPort,
  vaultKeyFromWidget,
  widgetBlockEnabled,
} from "./homepage-widget-utils.mjs";

export const DEFAULT_HA_TOKEN_VAULT_KEY = "HDC_HOMEPAGE_HA_TOKEN";
const HA_PORT = 8123;

/**
 * @param {Record<string, unknown>} homepage
 */
export function homeassistantWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "homeassistant_widget");
}

/**
 * @param {Record<string, unknown>} cfg
 */
function normalizeHomeassistantDeployments(cfg) {
  if (!isObject(cfg) || !Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("homeassistant config needs deployments[]");
  }
  return cfg.deployments.filter(isObject);
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.homeassistantPackageRoot
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} opts.vaultAccess
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageHomeassistantWidgetEnv(opts) {
  const { homepage, homeassistantPackageRoot, vaultAccess, dryRun = false } = opts;
  if (!homeassistantWidgetEnabled(homepage)) return null;

  errout.write("[hdc] homepage: resolving Home Assistant widget env …\n");

  const loaded = loadClumpConfigFromClumpRoot(homeassistantPackageRoot, {
    exampleRel: "clumps/services/homeassistant/config.example.json",
  });
  const deployments = normalizeHomeassistantDeployments(loaded.data);
  const deployment = deployments[0];
  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const ip = ipFromCidr(typeof q.ip === "string" ? q.ip : "");
  const url = serviceUrlFromHostPort(ip ?? "", HA_PORT);
  if (!url) {
    throw new Error("homepage homeassistant_widget: proxmox.qemu.ip required on first deployment");
  }

  const widget = /** @type {Record<string, unknown>} */ (homepage.homeassistant_widget);
  const vaultKey = vaultKeyFromWidget(widget, "token_vault_key", DEFAULT_HA_TOKEN_VAULT_KEY);

  if (dryRun) {
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_HOMEASSISTANT_* (vault ${vaultKey})`],
      vault_key: vaultKey,
      url,
    };
  }

  const token = await readRequiredVaultSecret(
    vaultAccess,
    vaultKey,
    `homepage homeassistant_widget requires long-lived HA access token in ${vaultKey}`,
  );

  errout.write(`[hdc] homepage: Home Assistant widget env ready (${url}, vault ${JSON.stringify(vaultKey)}).\n`);

  return {
    lines: [`HOMEPAGE_VAR_HOMEASSISTANT_URL=${url}`, `HOMEPAGE_VAR_HOMEASSISTANT_KEY=${token}`],
    vault_key: vaultKey,
    url,
  };
}
