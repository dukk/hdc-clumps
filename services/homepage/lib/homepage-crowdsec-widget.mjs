import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import {
  ipFromIpConfig,
  isObject,
  readRequiredVaultSecret,
  serviceUrlFromHostPort,
  vaultKeyFromWidget,
  widgetBlockEnabled,
} from "./homepage-widget-utils.mjs";

export const DEFAULT_CROWDSEC_LAPI_PASSWORD_VAULT_KEY = "HDC_HOMEPAGE_CROWDSEC_LAPI_PASSWORD";

/** @param {unknown} v */
function isObjectLocal(v) {
  return isObject(v);
}

/**
 * @param {Record<string, unknown>} cfg
 */
function normalizeCrowdsecConfig(cfg) {
  if (!isObjectLocal(cfg) || !Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("crowdsec config needs deployments[]");
  }
  const defaults = isObjectLocal(cfg.defaults) ? cfg.defaults : {};
  return { defaults, deployments: cfg.deployments.filter(isObjectLocal) };
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function crowdsecWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "crowdsec_widget");
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.crowdsecPackageRoot
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} opts.vaultAccess
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageCrowdsecWidgetEnv(opts) {
  const { homepage, crowdsecPackageRoot, vaultAccess, dryRun = false } = opts;
  if (!crowdsecWidgetEnabled(homepage)) return null;

  errout.write("[hdc] homepage: resolving CrowdSec widget env …\n");

  const loaded = loadClumpConfigFromClumpRoot(crowdsecPackageRoot, {
    exampleRel: "clumps/services/crowdsec/config.example.json",
  });
  const { defaults, deployments } = normalizeCrowdsecConfig(loaded.data);
  const deployment = deployments[0];
  const defaultCs = isObject(defaults.crowdsec) ? defaults.crowdsec : {};
  const deployCs = isObject(deployment.crowdsec) ? deployment.crowdsec : {};
  const merged = { ...defaultCs, ...deployCs };
  const portRaw = typeof merged.lapi_port === "number" ? merged.lapi_port : Number(merged.lapi_port);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 8080;

  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const defaultPx = isObject(defaults.proxmox) ? defaults.proxmox : {};
  const defaultLxc = isObject(defaultPx.lxc) ? defaultPx.lxc : {};
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const ipConfig =
    typeof lxc.ip_config === "string" && lxc.ip_config.trim()
      ? lxc.ip_config
      : typeof defaultLxc.ip_config === "string"
        ? defaultLxc.ip_config
        : "";
  const ip = ipFromIpConfig(ipConfig);
  const url = serviceUrlFromHostPort(ip ?? "", port);
  if (!url) {
    throw new Error("homepage crowdsec_widget: static proxmox.lxc.ip_config required");
  }

  const widget = /** @type {Record<string, unknown>} */ (homepage.crowdsec_widget);
  const vaultKey = vaultKeyFromWidget(widget, "token_vault_key", DEFAULT_CROWDSEC_LAPI_PASSWORD_VAULT_KEY);
  const machineId =
    typeof widget.machine_id === "string" && widget.machine_id.trim() ? widget.machine_id.trim() : "localhost";

  if (dryRun) {
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_CROWDSEC_* (vault ${vaultKey})`],
      vault_key: vaultKey,
      url,
      machine_id: machineId,
    };
  }

  const password = await readRequiredVaultSecret(
    vaultAccess,
    vaultKey,
    `homepage crowdsec_widget requires LAPI password in ${vaultKey} (from /etc/crowdsec/local_api_credentials.yaml on crowdsec-a)`,
  );

  errout.write(`[hdc] homepage: CrowdSec widget env ready (${url}, machine ${JSON.stringify(machineId)}).\n`);

  return {
    lines: [
      `HOMEPAGE_VAR_CROWDSEC_URL=${url}`,
      `HOMEPAGE_VAR_CROWDSEC_USER=${machineId}`,
      `HOMEPAGE_VAR_CROWDSEC_PASSWORD=${password}`,
    ],
    vault_key: vaultKey,
    url,
    machine_id: machineId,
  };
}
