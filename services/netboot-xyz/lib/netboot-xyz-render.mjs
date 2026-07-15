import {
  nginxHostPort,
  tftpHostPort,
  webAppPort,
} from "./deployments.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Ports PXE clients and operators need on the LXC host. */
export const REQUIRED_PORTS = {
  tcp: [3000, 8080],
  udp: [69],
  web_app_port: 3000,
  nginx_host_port: 8080,
  tftp_host_port: 69,
};

/**
 * @param {Record<string, unknown>} netbootXyz
 */
export function normalizeImage(netbootXyz) {
  const img = typeof netbootXyz.image === "string" ? netbootXyz.image.trim() : "";
  return img || "ghcr.io/netbootxyz/netbootxyz";
}

/**
 * @param {Record<string, unknown>} netbootXyz
 */
export function normalizeImageTag(netbootXyz) {
  const t = typeof netbootXyz.image_tag === "string" ? netbootXyz.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} netbootXyz
 */
export function nginxContainerPort(netbootXyz) {
  const p =
    typeof netbootXyz.nginx_port === "number" ? netbootXyz.nginx_port : Number(netbootXyz.nginx_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 80;
}

/**
 * @param {Record<string, unknown>} netbootXyz
 */
export function menuVersion(netbootXyz) {
  const v =
    typeof netbootXyz.menu_version === "string" ? netbootXyz.menu_version.trim() : "";
  return v || null;
}

/**
 * @param {Record<string, unknown>} netbootXyz
 */
export function tftpdOpts(netbootXyz) {
  if (netbootXyz.tftpd_opts === null || netbootXyz.tftpd_opts === undefined) {
    return "--tftp-single-port";
  }
  const o = typeof netbootXyz.tftpd_opts === "string" ? netbootXyz.tftpd_opts.trim() : "";
  return o || null;
}

/**
 * @param {Record<string, unknown>} netbootXyz
 */
export function timezone(netbootXyz) {
  const tz = typeof netbootXyz.timezone === "string" ? netbootXyz.timezone.trim() : "";
  return tz || "Etc/UTC";
}

/**
 * @param {Record<string, unknown>} netbootXyz
 */
export function puid(netbootXyz) {
  const p = typeof netbootXyz.puid === "number" ? netbootXyz.puid : Number(netbootXyz.puid);
  if (Number.isFinite(p) && p >= 0) return Math.floor(p);
  return 1000;
}

/**
 * @param {Record<string, unknown>} netbootXyz
 */
export function pgid(netbootXyz) {
  const p = typeof netbootXyz.pgid === "number" ? netbootXyz.pgid : Number(netbootXyz.pgid);
  if (Number.isFinite(p) && p >= 0) return Math.floor(p);
  return 1000;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/netboot-xyz";
}

/**
 * @param {Record<string, unknown>} netbootXyz
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(netbootXyz, install) {
  const image = normalizeImage(netbootXyz);
  const tag = normalizeImageTag(netbootXyz);
  const dir = composeDir(install).replace(/'/g, "''");
  const webPort = webAppPort(netbootXyz);
  const nginxHost = nginxHostPort(netbootXyz);
  const nginxContainer = nginxContainerPort(netbootXyz);
  const tftpHost = tftpHostPort(netbootXyz);
  const tz = timezone(netbootXyz);
  const menu = menuVersion(netbootXyz);
  const tftpd = tftpdOpts(netbootXyz);
  const uid = puid(netbootXyz);
  const gid = pgid(netbootXyz);

  const envLines = [
    `      - PUID=${uid}`,
    `      - PGID=${gid}`,
    `      - TZ=${tz}`,
    `      - WEB_APP_PORT=${webPort}`,
    `      - NGINX_PORT=${nginxContainer}`,
  ];
  if (menu) {
    envLines.push(`      - MENU_VERSION=${menu}`);
  }
  if (tftpd) {
    envLines.push(`      - TFTPD_OPTS=${tftpd}`);
  }

  return `services:
  netbootxyz:
    container_name: netbootxyz
    image: ${image}:${tag}
    restart: unless-stopped
    environment:
${envLines.join("\n")}
    ports:
      - '${webPort}:${webPort}'
      - '${tftpHost}:69/udp'
      - '${nginxHost}:${nginxContainer}'
    volumes:
      - '${dir}/config:/config'
      - '${dir}/assets:/assets'
`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} netbootXyz
 */
export function dhcpHints(ctIp, netbootXyz) {
  const cfg = isObject(netbootXyz) ? netbootXyz : {};
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  const webPort = webAppPort(cfg);
  const nginxHost = nginxHostPort(cfg);
  const tftpHost = tftpHostPort(cfg);

  return {
    next_server: ip || null,
    bios_boot_file: "netboot.xyz.kpxe",
    uefi_boot_file: "netboot.xyz.efi",
    web_ui_url: ip ? `http://${ip}:${webPort}` : null,
    assets_url: ip ? `http://${ip}:${nginxHost}/` : null,
    ports: {
      web_app_port: webPort,
      nginx_host_port: nginxHost,
      tftp_host_port: tftpHost,
    },
    examples: {
      generic_dhcp: ip
        ? {
            "next-server": ip,
            filename_bios: "netboot.xyz.kpxe",
            filename_uefi: "netboot.xyz.efi",
          }
        : null,
      dnsmasq: ip
        ? [
            `dhcp-boot=netboot.xyz.kpxe,${ip},${ip}`,
            "# Use a separate dnsmasq DHCP instance or proxy — do not enable TFTP here;",
            "# the netboot.xyz container serves TFTP on UDP 69.",
          ]
        : [],
      unifi_note:
        "UniFi Network: configure network boot on the LAN DHCP network — set boot server IP to next_server and boot file per architecture (BIOS vs UEFI).",
    },
    client_hint:
      "PXE clients need DHCP next-server and boot-filename from your existing LAN DHCP server; this package only hosts TFTP and HTTP assets.",
  };
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} netbootXyz
 */
export function resolveWebUiUrl(ctIp, netbootXyz) {
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${webAppPort(isObject(netbootXyz) ? netbootXyz : {})}`;
}
