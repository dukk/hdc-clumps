import { stderr as errout } from "node:process";

import {
  isObject,
  readRequiredVaultSecret,
  vaultKeyFromWidget,
  widgetBlockEnabled,
} from "./homepage-widget-utils.mjs";

export const DEFAULT_PLEX_TOKEN_VAULT_KEY = "HDC_HOMEPAGE_PLEX_TOKEN";
const DEFAULT_PLEX_URL = "http://192.0.2.9:32400";

/**
 * @param {Record<string, unknown>} homepage
 */
export function plexWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "plex_widget");
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} opts.vaultAccess
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepagePlexWidgetEnv(opts) {
  const { homepage, vaultAccess, dryRun = false } = opts;
  if (!plexWidgetEnabled(homepage)) return null;

  errout.write("[hdc] homepage: resolving Plex widget env …\n");

  const widget = /** @type {Record<string, unknown>} */ (homepage.plex_widget);
  const url =
    typeof widget.url === "string" && widget.url.trim() ? widget.url.trim().replace(/\/+$/, "") : DEFAULT_PLEX_URL;
  const vaultKey = vaultKeyFromWidget(widget, "token_vault_key", DEFAULT_PLEX_TOKEN_VAULT_KEY);

  if (dryRun) {
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_PLEX_* (vault ${vaultKey})`],
      vault_key: vaultKey,
      url,
    };
  }

  const token = await readRequiredVaultSecret(
    vaultAccess,
    vaultKey,
    `homepage plex_widget requires Plex token in ${vaultKey} (see plexopedia Plex token docs)`,
  );

  errout.write(`[hdc] homepage: Plex widget env ready (${url}, vault ${JSON.stringify(vaultKey)}).\n`);

  return {
    lines: [`HOMEPAGE_VAR_PLEX_URL=${url}`, `HOMEPAGE_VAR_PLEX_KEY=${token}`],
    vault_key: vaultKey,
    url,
  };
}
