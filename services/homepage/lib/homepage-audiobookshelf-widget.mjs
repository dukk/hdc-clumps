import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import {
  isObject,
  readRequiredVaultSecret,
  serviceUrlFromHostPort,
  vaultKeyFromWidget,
  widgetBlockEnabled,
} from "./homepage-widget-utils.mjs";

export const DEFAULT_AUDIOBOOKSHELF_TOKEN_VAULT_KEY = "HDC_HOMEPAGE_AUDIOBOOKSHELF_TOKEN";

/** @param {unknown} v */
function isObjectLocal(v) {
  return isObject(v);
}

/**
 * @param {Record<string, unknown>} cfg
 */
function normalizeAudiobookshelfConfig(cfg) {
  if (!isObjectLocal(cfg) || !Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("audiobookshelf config needs deployments[]");
  }
  const defaults = isObjectLocal(cfg.defaults) ? cfg.defaults : {};
  return { defaults, deployments: cfg.deployments.filter(isObjectLocal) };
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function audiobookshelfWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "audiobookshelf_widget");
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.audiobookshelfPackageRoot
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} opts.vaultAccess
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageAudiobookshelfWidgetEnv(opts) {
  const { homepage, audiobookshelfPackageRoot, vaultAccess, dryRun = false } = opts;
  if (!audiobookshelfWidgetEnabled(homepage)) return null;

  errout.write("[hdc] homepage: resolving Audiobookshelf widget env …\n");

  const loaded = loadClumpConfigFromClumpRoot(audiobookshelfPackageRoot, {
    exampleRel: "clumps/services/audiobookshelf/config.example.json",
  });
  const { defaults, deployments } = normalizeAudiobookshelfConfig(loaded.data);
  const deployment = deployments[0];
  const defaultAbs = isObject(defaults.audiobookshelf) ? defaults.audiobookshelf : {};
  const deployAbs = isObject(deployment.audiobookshelf) ? deployment.audiobookshelf : {};
  const merged = { ...defaultAbs, ...deployAbs };
  const portRaw = typeof merged.host_port === "number" ? merged.host_port : Number(merged.host_port);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 13378;

  const configure = isObject(deployment.configure) ? deployment.configure : {};
  const ssh = isObject(configure.ssh) ? configure.ssh : {};
  const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
  const url = serviceUrlFromHostPort(host, port);
  if (!url) {
    throw new Error("homepage audiobookshelf_widget: configure.ssh.host required on first deployment");
  }

  const widget = /** @type {Record<string, unknown>} */ (homepage.audiobookshelf_widget);
  const vaultKey = vaultKeyFromWidget(widget, "token_vault_key", DEFAULT_AUDIOBOOKSHELF_TOKEN_VAULT_KEY);

  if (dryRun) {
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_AUDIOBOOKSHELF_* (vault ${vaultKey})`],
      vault_key: vaultKey,
      url,
    };
  }

  const token = await readRequiredVaultSecret(
    vaultAccess,
    vaultKey,
    `homepage audiobookshelf_widget requires admin API token in ${vaultKey}`,
  );

  errout.write(`[hdc] homepage: Audiobookshelf widget env ready (${url}, vault ${JSON.stringify(vaultKey)}).\n`);

  return {
    lines: [`HOMEPAGE_VAR_AUDIOBOOKSHELF_URL=${url}`, `HOMEPAGE_VAR_AUDIOBOOKSHELF_KEY=${token}`],
    vault_key: vaultKey,
    url,
  };
}
