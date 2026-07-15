import { stderr as errout } from "node:process";

import { resolveHomepageAudiobookshelfWidgetEnv } from "./homepage-audiobookshelf-widget.mjs";
import { resolveHomepageBindWidgetEnv } from "./homepage-bind-widget.mjs";
import { resolveHomepageCrowdsecWidgetEnv } from "./homepage-crowdsec-widget.mjs";
import { resolveHomepageDiskstationWidgetEnv } from "./homepage-diskstation-widget.mjs";
import { resolveHomepageGlancesWidgetEnv } from "./homepage-glances-widget.mjs";
import { resolveHomepageHomeassistantWidgetEnv } from "./homepage-homeassistant-widget.mjs";
import { resolveHomepageImmichWidgetEnv } from "./homepage-immich-widget.mjs";
import { resolveHomepageMailcowWidgetEnv } from "./homepage-mailcow-widget.mjs";
import { resolveHomepagePiholeWidgetEnv } from "./homepage-pihole-widget.mjs";
import { resolveHomepagePlexWidgetEnv } from "./homepage-plex-widget.mjs";
import { resolveHomepageProxmoxWidgetEnv } from "./homepage-proxmox-widget.mjs";
import { resolveHomepageUnifiWidgetEnv } from "./homepage-unifi-widget.mjs";
import { resolveHomepageUptimeKumaWidgetEnv } from "./homepage-uptime-kuma-widget.mjs";

/**
 * Resolve all enabled Homepage service widget env lines for container .env injection.
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} opts.vaultAccess
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {(q: string, o?: { mask?: boolean }) => Promise<string>} [opts.readLineQuestion]
 * @param {boolean} [opts.dryRun]
 * @param {string} opts.proxmoxPackageRoot
 * @param {string} opts.piholePackageRoot
 * @param {string} opts.immichPackageRoot
 * @param {string} opts.glancesPackageRoot
 * @param {string} opts.homeassistantPackageRoot
 * @param {string} opts.audiobookshelfPackageRoot
 * @param {string} opts.uptimeKumaPackageRoot
 * @param {string} opts.crowdsecPackageRoot
 * @param {string} opts.unifiNetworkPackageRoot
 * @param {string} opts.synologyNasPackageRoot
 * @param {string} opts.mailcowPackageRoot
 * @param {string} opts.bindPackageRoot
 * @returns {Promise<{ lines: string[]; meta: Record<string, unknown>; statsFiles: import("./homepage-bind-widget.mjs").HomepageBindStatsFile[] }>}
 */
export async function resolveAllHomepageWidgetEnv(opts) {
  const {
    homepage,
    vaultAccess,
    env,
    spawnSync,
    readLineQuestion,
    dryRun = false,
    proxmoxPackageRoot,
    piholePackageRoot,
    immichPackageRoot,
    glancesPackageRoot,
    homeassistantPackageRoot,
    audiobookshelfPackageRoot,
    uptimeKumaPackageRoot,
    crowdsecPackageRoot,
    unifiNetworkPackageRoot,
    synologyNasPackageRoot,
    mailcowPackageRoot,
    bindPackageRoot,
  } = opts;

  errout.write("[hdc] homepage: resolving service widget env …\n");

  /** @type {string[]} */
  const lines = [];
  /** @type {Record<string, unknown>} */
  const meta = {};
  /** @type {import("./homepage-bind-widget.mjs").HomepageBindStatsFile[]} */
  const statsFiles = [];

  const proxmox = await resolveHomepageProxmoxWidgetEnv({
    homepage,
    proxmoxPackageRoot,
    vaultAccess,
    env,
    spawnSync,
    readLineQuestion,
    dryRun,
  });
  if (proxmox) {
    lines.push(...proxmox.lines);
    meta.proxmox_widget = {
      service_account_id: proxmox.service_account_id,
      token_vault_key: proxmox.token_vault_key,
    };
  }

  const pihole = await resolveHomepagePiholeWidgetEnv({
    homepage,
    piholePackageRoot,
    dryRun,
  });
  if (pihole) {
    lines.push(...pihole.lines);
    meta.pihole_widget = { version: pihole.version, instances: pihole.instances };
  }

  const immich = await resolveHomepageImmichWidgetEnv({
    homepage,
    immichPackageRoot,
    dryRun,
  });
  if (immich) {
    lines.push(...immich.lines);
    meta.immich_widget = { vault_key: immich.vault_key, url: immich.url };
  }

  const glances = await resolveHomepageGlancesWidgetEnv({
    homepage,
    glancesPackageRoot,
    dryRun,
  });
  if (glances) {
    lines.push(...glances.lines);
    meta.glances_widget = { url: glances.url };
  }

  const ha = await resolveHomepageHomeassistantWidgetEnv({
    homepage,
    homeassistantPackageRoot,
    vaultAccess,
    dryRun,
  });
  if (ha) {
    lines.push(...ha.lines);
    meta.homeassistant_widget = { vault_key: ha.vault_key, url: ha.url };
  }

  const plex = await resolveHomepagePlexWidgetEnv({ homepage, vaultAccess, dryRun });
  if (plex) {
    lines.push(...plex.lines);
    meta.plex_widget = { vault_key: plex.vault_key, url: plex.url };
  }

  const audiobookshelf = await resolveHomepageAudiobookshelfWidgetEnv({
    homepage,
    audiobookshelfPackageRoot,
    vaultAccess,
    dryRun,
  });
  if (audiobookshelf) {
    lines.push(...audiobookshelf.lines);
    meta.audiobookshelf_widget = { vault_key: audiobookshelf.vault_key, url: audiobookshelf.url };
  }

  const uptimeKuma = await resolveHomepageUptimeKumaWidgetEnv({
    homepage,
    uptimeKumaPackageRoot,
    dryRun,
  });
  if (uptimeKuma) {
    lines.push(...uptimeKuma.lines);
    meta.uptime_kuma_widget = {
      url: uptimeKuma.url,
      slug: uptimeKuma.slug,
      instances: uptimeKuma.instances ?? [],
    };
  }

  const crowdsec = await resolveHomepageCrowdsecWidgetEnv({
    homepage,
    crowdsecPackageRoot,
    vaultAccess,
    dryRun,
  });
  if (crowdsec) {
    lines.push(...crowdsec.lines);
    meta.crowdsec_widget = {
      vault_key: crowdsec.vault_key,
      url: crowdsec.url,
      machine_id: crowdsec.machine_id,
    };
  }

  const unifi = await resolveHomepageUnifiWidgetEnv({
    homepage,
    unifiNetworkPackageRoot,
    vaultAccess,
    dryRun,
  });
  if (unifi) {
    lines.push(...unifi.lines);
    meta.unifi_widget = {
      vault_key: unifi.vault_key,
      url: unifi.url,
      site: unifi.site,
    };
  }

  const diskstation = await resolveHomepageDiskstationWidgetEnv({
    homepage,
    synologyNasPackageRoot,
    vaultAccess,
    dryRun,
  });
  if (diskstation) {
    lines.push(...diskstation.lines);
    meta.diskstation_widget = { instances: diskstation.instances };
  }

  const mailcow = await resolveHomepageMailcowWidgetEnv({
    homepage,
    mailcowPackageRoot,
    vaultAccess,
    dryRun,
  });
  if (mailcow) {
    lines.push(...mailcow.lines);
    meta.mailcow_widget = { vault_key: mailcow.vault_key, url: mailcow.url };
  }

  const bind = await resolveHomepageBindWidgetEnv({
    homepage,
    bindPackageRoot,
    dryRun,
  });
  if (bind) {
    lines.push(...bind.lines);
    statsFiles.push(...(bind.statsFiles ?? []));
    meta.bind_widget = { zones_total: bind.zones_total, stats_files: bind.statsFiles?.length ?? 0 };
  }

  errout.write(`[hdc] homepage: widget env ready (${lines.length} line(s)).\n`);

  return { lines, meta, statsFiles };
}
