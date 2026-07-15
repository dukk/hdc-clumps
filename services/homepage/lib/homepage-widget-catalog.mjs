/**
 * Dashboard tile ↔ gethomepage widget catalog for lint and documentation.
 * @typedef {{
 *   tileNames: string[];
 *   widgetType: string;
 *   configKey: string;
 *   placeholders: string[];
 *   builtin?: boolean;
 * }} HomepageWidgetCatalogEntry
 */

/** @type {HomepageWidgetCatalogEntry[]} */
export const HOMEPAGE_WIDGET_CATALOG = [
  {
    tileNames: [
      "Proxmox Cluster",
      "Proxmox A",
      "Proxmox B",
      "Proxmox C",
      "Proxmox D",
      "Proxmox H",
    ],
    widgetType: "proxmox",
    configKey: "proxmox_widget",
    placeholders: [
      "HOMEPAGE_VAR_PROXMOX_USER",
      "HOMEPAGE_VAR_PROXMOX_SECRET",
      "HOMEPAGE_VAR_PROXMOX_",
    ],
    builtin: true,
  },
  {
    tileNames: ["Pi-hole A", "Pi-hole B"],
    widgetType: "pihole",
    configKey: "pihole_widget",
    placeholders: ["HOMEPAGE_VAR_PIHOLE_"],
    builtin: true,
  },
  {
    tileNames: ["Immich"],
    widgetType: "immich",
    configKey: "immich_widget",
    placeholders: ["HOMEPAGE_VAR_IMMICH_URL", "HOMEPAGE_VAR_IMMICH_KEY"],
  },
  {
    tileNames: ["Home Assistant"],
    widgetType: "homeassistant",
    configKey: "homeassistant_widget",
    placeholders: ["HOMEPAGE_VAR_HOMEASSISTANT_URL", "HOMEPAGE_VAR_HOMEASSISTANT_KEY"],
  },
  {
    tileNames: ["Plex"],
    widgetType: "plex",
    configKey: "plex_widget",
    placeholders: ["HOMEPAGE_VAR_PLEX_URL", "HOMEPAGE_VAR_PLEX_KEY"],
  },
  {
    tileNames: ["Audiobookshelf"],
    widgetType: "audiobookshelf",
    configKey: "audiobookshelf_widget",
    placeholders: ["HOMEPAGE_VAR_AUDIOBOOKSHELF_URL", "HOMEPAGE_VAR_AUDIOBOOKSHELF_KEY"],
  },
  {
    tileNames: ["Uptime Kuma", "Uptime Kuma (Public Edge)"],
    widgetType: "uptimekuma",
    configKey: "uptime_kuma_widget",
    placeholders: ["HOMEPAGE_VAR_UPTIME_KUMA_"],
  },
  {
    tileNames: ["Glances"],
    widgetType: "glances",
    configKey: "glances_widget",
    placeholders: ["HOMEPAGE_VAR_GLANCES_URL"],
  },
  {
    tileNames: ["CrowdSec"],
    widgetType: "crowdsec",
    configKey: "crowdsec_widget",
    placeholders: [
      "HOMEPAGE_VAR_CROWDSEC_URL",
      "HOMEPAGE_VAR_CROWDSEC_USER",
      "HOMEPAGE_VAR_CROWDSEC_PASSWORD",
    ],
  },
  {
    tileNames: ["UniFi"],
    widgetType: "unifi",
    configKey: "unifi_widget",
    placeholders: ["HOMEPAGE_VAR_UNIFI_URL", "HOMEPAGE_VAR_UNIFI_KEY"],
  },
  {
    tileNames: ["NAS-1 DSM", "NAS-2 DSM"],
    widgetType: "diskstation",
    configKey: "diskstation_widget",
    placeholders: ["HOMEPAGE_VAR_DISKSTATION_"],
  },
  {
    tileNames: ["Mailcow"],
    widgetType: "mailcow",
    configKey: "mailcow_widget",
    placeholders: ["HOMEPAGE_VAR_MAILCOW_URL", "HOMEPAGE_VAR_MAILCOW_KEY"],
  },
  {
    tileNames: ["BIND A", "BIND B"],
    widgetType: "customapi",
    configKey: "bind_widget",
    placeholders: [],
    builtin: true,
  },
];

/**
 * @param {string} widgetType
 */
export function catalogEntryByWidgetType(widgetType) {
  const t = typeof widgetType === "string" ? widgetType.trim().toLowerCase() : "";
  return HOMEPAGE_WIDGET_CATALOG.find((e) => e.widgetType === t) ?? null;
}

/**
 * @param {string} tileName
 */
export function catalogEntryByTileName(tileName) {
  const n = typeof tileName === "string" ? tileName.trim() : "";
  return HOMEPAGE_WIDGET_CATALOG.find((e) => e.tileNames.includes(n)) ?? null;
}

/**
 * @param {string} configKey
 */
export function catalogEntryByConfigKey(configKey) {
  const k = typeof configKey === "string" ? configKey.trim() : "";
  return HOMEPAGE_WIDGET_CATALOG.find((e) => e.configKey === k) ?? null;
}
