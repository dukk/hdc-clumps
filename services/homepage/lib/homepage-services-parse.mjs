/**
 * Parse gethomepage services.yaml (fixed hdc layout: groups → services → 8-space keys).
 * @typedef {{ name: string; icon?: string; siteMonitor?: string; ping?: string; description?: string; widget?: Record<string, unknown>; raw: string }} ParsedHomepageService
 * @typedef {{ name: string; services: ParsedHomepageService[] }} ParsedHomepageGroup
 */

/**
 * @param {string} line
 */
function unquoteYamlKey(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * @param {string} yamlText
 * @returns {ParsedHomepageGroup[]}
 */
export function parseHomepageServicesYaml(yamlText) {
  const text = typeof yamlText === "string" ? yamlText.replace(/\r\n/g, "\n") : "";
  /** @type {ParsedHomepageGroup[]} */
  const groups = [];
  /** @type {ParsedHomepageGroup | null} */
  let currentGroup = null;
  /** @type {ParsedHomepageService | null} */
  let currentService = null;
  /** @type {string[] | null} */
  let rawLines = null;
  /** @type {string | null} */
  let widgetKey = null;
  /** @type {Record<string, unknown> | null} */
  let widgetObj = null;

  const flushService = () => {
    if (currentGroup && currentService) {
      if (widgetObj && widgetKey) {
        currentService.widget = widgetObj;
      }
      currentService.raw = (rawLines ?? []).join("\n");
      currentGroup.services.push(currentService);
    }
    currentService = null;
    rawLines = null;
    widgetKey = null;
    widgetObj = null;
  };

  for (const line of text.split("\n")) {
    const groupMatch = line.match(/^-\s+(.+):\s*$/);
    if (groupMatch && !line.startsWith("    ")) {
      flushService();
      currentGroup = { name: unquoteYamlKey(groupMatch[1]), services: [] };
      groups.push(currentGroup);
      continue;
    }

    const serviceMatch = line.match(/^ {4}-\s+(.+):\s*$/);
    if (serviceMatch) {
      flushService();
      if (!currentGroup) continue;
      currentService = { name: unquoteYamlKey(serviceMatch[1]) };
      rawLines = [line];
      continue;
    }

    if (!currentService || !rawLines) continue;
    rawLines.push(line);

    const propMatch = line.match(/^ {8}(\w+):\s*(.*)$/);
    if (propMatch) {
      const key = propMatch[1];
      const val = propMatch[2].trim();
      if (key === "icon") {
        currentService.icon = unquoteYamlKey(val);
      } else if (key === "siteMonitor" || key === "site_monitor") {
        currentService.siteMonitor = unquoteYamlKey(val);
      } else if (key === "ping") {
        currentService.ping = unquoteYamlKey(val);
      } else if (key === "description") {
        currentService.description = unquoteYamlKey(val);
      } else if (key === "widget") {
        widgetKey = "widget";
        widgetObj = {};
      } else if (widgetObj && widgetKey) {
        widgetObj[key] = unquoteYamlKey(val);
      }
      continue;
    }

    const widgetPropMatch = line.match(/^ {10}(\w+):\s*(.*)$/);
    if (widgetPropMatch && widgetObj) {
      const key = widgetPropMatch[1];
      const val = widgetPropMatch[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        widgetObj[key] = val;
      } else {
        widgetObj[key] = unquoteYamlKey(val);
      }
    }
  }

  flushService();
  return groups;
}

/**
 * @param {ParsedHomepageGroup[]} groups
 */
export function flattenHomepageServices(groups) {
  /** @type {ParsedHomepageService[]} */
  const out = [];
  for (const g of groups) {
    for (const s of g.services) out.push(s);
  }
  return out;
}
