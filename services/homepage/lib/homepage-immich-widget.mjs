import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { apiKeyVaultKey, resolveImmichApiKey } from "../../immich/lib/immich-vault-deps.mjs";
import { normalizeImmichConfig } from "../../immich/lib/deployments.mjs";
import { createImmichVaultAccess } from "../../immich/lib/vault-deps.mjs";
import { isObject, serviceUrlFromHostPort, widgetBlockEnabled } from "./homepage-widget-utils.mjs";

/**
 * @param {Record<string, unknown>} homepage
 */
export function immichWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "immich_widget");
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.immichPackageRoot
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageImmichWidgetEnv(opts) {
  const { homepage, immichPackageRoot, dryRun = false } = opts;
  if (!immichWidgetEnabled(homepage)) return null;

  errout.write("[hdc] homepage: resolving Immich widget env from immich config …\n");

  const loaded = loadClumpConfigFromClumpRoot(immichPackageRoot, {
    exampleRel: "clumps/services/immich/config.example.json",
  });
  const { defaults, deployments } = normalizeImmichConfig(loaded.data);
  const deployment = deployments[0];
  if (!deployment) {
    throw new Error("homepage immich_widget: no immich deployments in config");
  }

  const defaultImmich = isObject(defaults.immich) ? defaults.immich : {};
  const deployImmich = isObject(deployment.immich) ? deployment.immich : {};
  const mergedImmich = { ...defaultImmich, ...deployImmich };
  const portRaw = typeof mergedImmich.port === "number" ? mergedImmich.port : Number(mergedImmich.port);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 2283;

  const configure = isObject(deployment.configure) ? deployment.configure : {};
  const ssh = isObject(configure.ssh) ? configure.ssh : {};
  let host = typeof ssh.host === "string" ? ssh.host.trim() : "";
  if (!host) {
    const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
    const q = isObject(px.qemu) ? px.qemu : {};
    const ip = typeof q.ip === "string" ? q.ip.split("/")[0]?.trim() : "";
    host = ip;
  }
  const url = serviceUrlFromHostPort(host, port);
  if (!url) {
    throw new Error("homepage immich_widget: could not resolve Immich LAN URL (configure.ssh.host or proxmox.qemu.ip)");
  }

  const vaultKey = apiKeyVaultKey(mergedImmich);
  if (dryRun) {
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_IMMICH_* (vault ${vaultKey})`],
      vault_key: vaultKey,
      url,
    };
  }

  const immichVault = createImmichVaultAccess();
  const apiKey = await resolveImmichApiKey(immichVault, mergedImmich, {
    required: false,
    promptLabel: `Immich API key for homepage widget (${vaultKey})`,
  });
  if (!apiKey) {
    errout.write(
      `[hdc] homepage: WARN immich_widget skipped — set ${vaultKey} to enable the Immich dashboard widget.\n`,
    );
    return null;
  }

  errout.write(`[hdc] homepage: Immich widget env ready (${url}, vault ${JSON.stringify(vaultKey)}).\n`);

  return {
    lines: [`HOMEPAGE_VAR_IMMICH_URL=${url}`, `HOMEPAGE_VAR_IMMICH_KEY=${apiKey}`],
    vault_key: vaultKey,
    url,
  };
}
