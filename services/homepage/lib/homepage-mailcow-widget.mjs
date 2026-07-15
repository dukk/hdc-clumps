import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { normalizeMailcowConfig } from "../../mailcow/lib/deployments.mjs";
import { apiKeyVaultKey, resolveApiBaseUrl } from "../../mailcow/lib/mailcow-render.mjs";
import {
  isObject,
  readRequiredVaultSecret,
  widgetBlockEnabled,
} from "./homepage-widget-utils.mjs";

/**
 * @param {Record<string, unknown>} homepage
 */
export function mailcowWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "mailcow_widget");
}

/**
 * @param {Record<string, unknown>} mailcowCfg
 * @returns {{ url: string; vaultKey: string }}
 */
export function resolveMailcowWidgetCredentials(mailcowCfg) {
  const { defaults, deployments } = normalizeMailcowConfig(mailcowCfg);
  const deployment = deployments[0];
  if (!deployment) {
    throw new Error("homepage mailcow_widget: no mailcow deployments in config");
  }

  const defaultMailcow = isObject(defaults.mailcow) ? defaults.mailcow : {};
  const deployMailcow = isObject(deployment.mailcow) ? deployment.mailcow : {};
  const merged = { ...defaultMailcow, ...deployMailcow };

  const url = resolveApiBaseUrl(merged);
  if (!url) {
    throw new Error("homepage mailcow_widget: could not resolve mailcow API URL");
  }

  const vaultKey = apiKeyVaultKey(merged);
  return { url, vaultKey };
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.mailcowPackageRoot
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} opts.vaultAccess
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageMailcowWidgetEnv(opts) {
  const { homepage, mailcowPackageRoot, vaultAccess, dryRun = false } = opts;
  if (!mailcowWidgetEnabled(homepage)) return null;

  errout.write("[hdc] homepage: resolving Mailcow widget env from mailcow config …\n");

  const loaded = loadClumpConfigFromClumpRoot(mailcowPackageRoot, {
    exampleRel: "clumps/services/mailcow/config.example.json",
  });
  const { url, vaultKey } = resolveMailcowWidgetCredentials(loaded.data);

  if (dryRun) {
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_MAILCOW_* (vault ${vaultKey})`],
      vault_key: vaultKey,
      url,
    };
  }

  const apiKey = await readRequiredVaultSecret(
    vaultAccess,
    vaultKey,
    `homepage mailcow_widget requires API key in ${vaultKey}`,
  );

  errout.write(`[hdc] homepage: Mailcow widget env ready (${url}, vault ${JSON.stringify(vaultKey)}).\n`);

  return {
    lines: [`HOMEPAGE_VAR_MAILCOW_URL=${url}`, `HOMEPAGE_VAR_MAILCOW_KEY=${apiKey}`],
    vault_key: vaultKey,
    url,
  };
}
