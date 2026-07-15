import { stderr as errout } from "node:process";

import { controllerFromPackageConfig } from "../../../infrastructure/unifi-network/lib/unifi-config.mjs";
import { UNIFI_API_KEY_VAULT_KEY } from "../../../infrastructure/unifi-network/lib/vault-deps.mjs";
import { tryLoadClumpConfigOrExample } from "hdc/package/clump-run-config.mjs";
import {
  vaultKeyFromWidget,
  widgetBlockEnabled,
} from "./homepage-widget-utils.mjs";

/**
 * @param {Record<string, unknown>} homepage
 */
export function unifiWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "unifi_widget");
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.unifiNetworkPackageRoot
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} opts.vaultAccess
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageUnifiWidgetEnv(opts) {
  const { homepage, unifiNetworkPackageRoot, vaultAccess, dryRun = false } = opts;
  if (!unifiWidgetEnabled(homepage)) return null;

  errout.write("[hdc] homepage: resolving UniFi widget env …\n");

  const loaded = tryLoadClumpConfigOrExample(unifiNetworkPackageRoot, {
    exampleRel: "clumps/infrastructure/unifi-network/config.example.json",
  });
  if (!loaded?.ok || !loaded.data) {
    throw new Error("homepage unifi_widget: unifi-network config not found");
  }
  const controller = controllerFromPackageConfig(loaded.data);
  if (!controller?.url) {
    throw new Error("homepage unifi_widget: unifi-network controller_base_url required");
  }
  const url = controller.url.replace(/\/+$/, "");

  // Homepage matches site against classic /stat/sites `desc`, not Integration API
  // default_site_id. Only inject when operators set homepage.unifi_widget.site
  // explicitly; otherwise Homepage uses classic name === "default".
  const widget = /** @type {Record<string, unknown>} */ (homepage.unifi_widget);
  const site =
    typeof widget?.site === "string" && widget.site.trim() ? widget.site.trim() : "";
  const vaultKey = vaultKeyFromWidget(widget, "api_key_vault_key", UNIFI_API_KEY_VAULT_KEY);

  if (dryRun) {
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_UNIFI_* (vault ${vaultKey})`],
      vault_key: vaultKey,
      url,
      site: site || null,
    };
  }

  const apiKey = (await vaultAccess.getSecret(vaultKey, { optional: true })).trim();
  if (!apiKey) {
    errout.write(
      `[hdc] homepage: WARN unifi_widget skipped — set ${vaultKey} (UniFi Integrations API key) to enable the widget.\n`,
    );
    return null;
  }

  /** @type {string[]} */
  const lines = [`HOMEPAGE_VAR_UNIFI_URL=${url}`, `HOMEPAGE_VAR_UNIFI_KEY=${apiKey}`];
  if (site) {
    lines.push(`HOMEPAGE_VAR_UNIFI_SITE=${site}`);
  }

  errout.write(
    `[hdc] homepage: UniFi widget env ready (${url}${site ? `, site ${JSON.stringify(site)}` : ""}).\n`,
  );

  return {
    lines,
    vault_key: vaultKey,
    url,
    site: site || null,
  };
}
