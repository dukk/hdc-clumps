import { proxmoxWidgetEnabled } from "./homepage-proxmox-widget.mjs";
import { bindWidgetEnabled } from "./homepage-bind-widget.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} s
 */
function yamlQuote(s) {
  const str = String(s);
  if (
    str === "" ||
    /[:#\[\]{}&,*?|>!'"%@`]/.test(str) ||
    str.includes("\n") ||
    /^\s/.test(str) ||
    /^(true|false|null|yes|no|on|off)$/i.test(str)
  ) {
    return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return str;
}

/**
 * @param {number} indent
 * @param {string} line
 */
function indentLine(indent, line) {
  return `${"  ".repeat(indent)}${line}`;
}

/**
 * @param {unknown} value
 * @param {number} indent
 * @returns {string[]}
 */
function renderYamlValue(value, indent) {
  if (value === null || value === undefined) return [];
  if (typeof value === "boolean") return [indentLine(indent, value ? "true" : "false")];
  if (typeof value === "number") return [indentLine(indent, String(value))];
  if (typeof value === "string") return [indentLine(indent, yamlQuote(value))];
  if (Array.isArray(value)) {
    const lines = [];
    for (const item of value) {
      if (isObject(item)) {
        const keys = Object.keys(item);
        if (keys.length === 1) {
          const k = keys[0];
          lines.push(indentLine(indent, `- ${yamlQuote(k)}:`));
          lines.push(...renderYamlMap(item[k], indent + 1));
        } else {
          lines.push(indentLine(indent, "-"));
          lines.push(...renderYamlMap(item, indent + 1));
        }
      } else {
        lines.push(indentLine(indent, `- ${yamlQuote(String(item))}`));
      }
    }
    return lines;
  }
  if (isObject(value)) {
    return renderYamlMap(value, indent);
  }
  return [indentLine(indent, yamlQuote(String(value)))];
}

/**
 * @param {Record<string, unknown>} obj
 * @param {number} indent
 * @returns {string[]}
 */
function renderYamlMap(obj, indent) {
  /** @type {string[]} */
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    if (isObject(val) && !Array.isArray(val)) {
      lines.push(indentLine(indent, `${key}:`));
      lines.push(...renderYamlMap(val, indent + 1));
    } else if (Array.isArray(val)) {
      lines.push(indentLine(indent, `${key}:`));
      lines.push(...renderYamlValue(val, indent + 1));
    } else {
      lines.push(indentLine(indent, `${key}: ${typeof val === "string" ? yamlQuote(val) : val}`));
    }
  }
  return lines;
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function normalizePublicUrl(homepage) {
  const d = typeof homepage.public_url === "string" ? homepage.public_url.trim() : "";
  if (!d) return null;
  if (!/^https:\/\//i.test(d)) {
    throw new Error("homepage.public_url must start with https:// when set");
  }
  return d.replace(/\/+$/, "");
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function normalizeImageTag(homepage) {
  const t = typeof homepage.image_tag === "string" ? homepage.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function hostPort(homepage) {
  const p = typeof homepage.host_port === "number" ? homepage.host_port : Number(homepage.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3000;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/homepage";
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function allowedHosts(homepage) {
  const raw = homepage.allowed_hosts;
  /** @type {string[]} */
  const hosts = [];
  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (typeof h === "string" && h.trim()) hosts.push(h.trim());
    }
  }
  if (hosts.length === 0) {
    try {
      const url = normalizePublicUrl(homepage);
      if (url) {
        hosts.push(new URL(url).host);
      }
    } catch {
      /* ignore */
    }
  }
  if (hosts.length === 0) {
    throw new Error("homepage.allowed_hosts[] is required (comma-free host list for HOMEPAGE_ALLOWED_HOSTS)");
  }
  return hosts.join(",");
}

/**
 * @param {Record<string, unknown>} svc
 */
function serviceEntryToYamlObject(svc) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (typeof svc.icon === "string" && svc.icon.trim()) out.icon = svc.icon.trim();
  if (typeof svc.href === "string" && svc.href.trim()) out.href = svc.href.trim();
  if (typeof svc.description === "string" && svc.description.trim()) out.description = svc.description.trim();
  const siteMonitor =
    typeof svc.site_monitor === "string" && svc.site_monitor.trim()
      ? svc.site_monitor.trim()
      : typeof svc.siteMonitor === "string" && svc.siteMonitor.trim()
        ? svc.siteMonitor.trim()
        : null;
  if (siteMonitor) out.siteMonitor = siteMonitor;
  if (typeof svc.ping === "string" && svc.ping.trim()) out.ping = svc.ping.trim();
  if (typeof svc.target === "string" && svc.target.trim()) out.target = svc.target.trim();
  if (isObject(svc.widget)) out.widget = svc.widget;
  return out;
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function renderServicesYaml(homepage) {
  const groups = homepage.service_groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return "- Getting started:\n    - Homepage:\n        icon: homepage.png\n        href: /\n        description: Edit service_groups in hdc config\n";
  }

  /** @type {string[]} */
  const lines = [];
  for (const group of groups) {
    if (!isObject(group)) continue;
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (!name) continue;
    lines.push(`- ${yamlQuote(name)}:`);
    const services = Array.isArray(group.services) ? group.services : [];
    for (const svc of services) {
      if (!isObject(svc)) continue;
      const svcName = typeof svc.name === "string" ? svc.name.trim() : "";
      if (!svcName) continue;
      lines.push(`    - ${yamlQuote(svcName)}:`);
      const fields = serviceEntryToYamlObject(svc);
      for (const [key, val] of Object.entries(fields)) {
        if (isObject(val) && !Array.isArray(val)) {
          lines.push(`        ${key}:`);
          lines.push(...renderYamlMap(val, 4).map((l) => l.replace(/^ {8}/, "        ")));
        } else if (Array.isArray(val)) {
          lines.push(`        ${key}:`);
          lines.push(...renderYamlValue(val, 4).map((l) => l.replace(/^ {8}/, "        ")));
        } else {
          lines.push(`        ${key}: ${typeof val === "string" ? yamlQuote(val) : val}`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function renderSettingsYaml(homepage) {
  /** @type {Record<string, unknown>} */
  const settings = {};
  const title = typeof homepage.title === "string" ? homepage.title.trim() : "";
  if (title) settings.title = title;
  const description = typeof homepage.description === "string" ? homepage.description.trim() : "";
  if (description) settings.description = description;
  const theme = typeof homepage.theme === "string" ? homepage.theme.trim() : "";
  if (theme) settings.theme = theme;
  const startUrl = typeof homepage.start_url === "string" ? homepage.start_url.trim() : "";
  if (startUrl) settings.startUrl = startUrl;
  if (isObject(homepage.layout)) settings.layout = homepage.layout;
  if (homepage.full_width === true) settings.fullWidth = true;
  if (homepage.disable_indexing === true) settings.disableIndexing = true;

  if (Object.keys(settings).length === 0) {
    return "title: HDC\n";
  }
  return `${renderYamlMap(settings, 0).join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function renderBookmarksYaml(homepage) {
  const bookmarks = homepage.bookmarks;
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
    return "[]\n";
  }
  /** @type {string[]} */
  const lines = [];
  for (const group of bookmarks) {
    if (!isObject(group)) continue;
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (!name) continue;
    lines.push(`- ${yamlQuote(name)}:`);
    const items = Array.isArray(group.items) ? group.items : [];
    for (const item of items) {
      if (!isObject(item)) continue;
      const itemName = typeof item.name === "string" ? item.name.trim() : "";
      const href = typeof item.href === "string" ? item.href.trim() : "";
      if (!itemName || !href) continue;
      lines.push(`    - ${yamlQuote(itemName)}:`);
      lines.push(`        href: ${yamlQuote(href)}`);
      if (typeof item.icon === "string" && item.icon.trim()) {
        lines.push(`        icon: ${yamlQuote(item.icon.trim())}`);
      }
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "[]\n";
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function renderHomepageConfigFiles(homepage) {
  return {
    servicesYaml: renderServicesYaml(homepage),
    settingsYaml: renderSettingsYaml(homepage),
    bookmarksYaml: renderBookmarksYaml(homepage),
  };
}

/**
 * When true, inject NODE_TLS_REJECT_UNAUTHORIZED=0 for Proxmox widget/siteMonitor HTTPS
 * against self-signed PVE node certs (default on when proxmox_widget is enabled).
 * @param {Record<string, unknown>} homepage
 */
export function proxmoxWidgetTlsInsecure(homepage) {
  if (!proxmoxWidgetEnabled(homepage)) return false;
  const widget = homepage.proxmox_widget;
  if (!isObject(widget)) return true;
  if (widget.tls_insecure === false || widget.tls_insecure === 0) return false;
  return true;
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function renderHomepageEnv(homepage, widgetLines = []) {
  const tag = normalizeImageTag(homepage);
  const port = hostPort(homepage);
  const hosts = allowedHosts(homepage);

  /** @type {string[]} */
  const lines = [
    "# hdc-generated — docker compose",
    `HOMEPAGE_IMAGE_TAG=${tag}`,
    `HOMEPAGE_HOST_PORT=${port}`,
    `HOMEPAGE_ALLOWED_HOSTS=${hosts}`,
    ...widgetLines,
  ];
  if (proxmoxWidgetTlsInsecure(homepage)) {
    lines.push("NODE_TLS_REJECT_UNAUTHORIZED=0");
  }
  return `${lines.join("\n")}\n`;
}

export function renderDockerfile() {
  return `# hdc-generated — extends upstream gethomepage with iputils for ICMP ping
ARG HOMEPAGE_BASE_TAG=latest
FROM ghcr.io/gethomepage/homepage:\${HOMEPAGE_BASE_TAG}
USER root
RUN apk add --no-cache iputils
USER node
`;
}

export function renderComposeYaml(homepage = {}) {
  /** @type {string[]} */
  const volumes = [
    "      - ./config:/app/config",
    "      - ./icons:/app/public/icons",
  ];
  if (bindWidgetEnabled(/** @type {Record<string, unknown>} */ (homepage))) {
    volumes.push("      - ./stats:/app/public/stats");
  }

  return `services:
  homepage:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        HOMEPAGE_BASE_TAG: \${HOMEPAGE_IMAGE_TAG}
    image: hdc-homepage:\${HOMEPAGE_IMAGE_TAG}
    container_name: homepage
    restart: unless-stopped
    cap_add:
      - NET_RAW
    ports:
      - "\${HOMEPAGE_HOST_PORT}:3000"
    env_file:
      - .env
    volumes:
${volumes.join("\n")}
    environment:
      HOMEPAGE_ALLOWED_HOSTS: \${HOMEPAGE_ALLOWED_HOSTS}

`;
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function resolveWebUrl(homepage) {
  const publicUrl = normalizePublicUrl(homepage);
  if (publicUrl) return publicUrl;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} homepage
 */
export function resolveUpstreamUrl(ctIp, homepage) {
  const port = hostPort(homepage);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
