import {
  gatusMailAlertingYaml,
} from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * YAML-safe string (double-quoted when needed).
 * @param {string} s
 */
export function yamlQuote(s) {
  const t = String(s);
  if (/^[\w./:@%+-]+$/.test(t) && !t.includes(":")) return t;
  return `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * @param {unknown} val
 * @param {number} indent
 */
function yamlScalar(val, indent) {
  const pad = " ".repeat(indent);
  if (val === null || val === undefined) return `${pad}null`;
  if (typeof val === "boolean") return `${pad}${val ? "true" : "false"}`;
  if (typeof val === "number" && Number.isFinite(val)) return `${pad}${val}`;
  if (typeof val === "string") return `${pad}${yamlQuote(val)}`;
  return `${pad}${yamlQuote(String(val))}`;
}

/**
 * @param {unknown[]} arr
 * @param {number} indent
 */
function yamlStringList(arr, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const item of arr) {
    if (typeof item !== "string" || !item.trim()) continue;
    lines.push(`${pad}- ${yamlQuote(item.trim())}`);
  }
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} ep
 */
function renderEndpoint(ep) {
  const name = typeof ep.name === "string" ? ep.name.trim() : "";
  if (!name) throw new Error("each endpoint needs name");
  const lines = [`  - name: ${yamlQuote(name)}`];
  if (typeof ep.group === "string" && ep.group.trim()) {
    lines.push(`    group: ${yamlQuote(ep.group.trim())}`);
  }
  const url = typeof ep.url === "string" ? ep.url.trim() : "";
  if (!url) throw new Error(`endpoint ${name}: url required`);
  lines.push(`    url: ${yamlQuote(url)}`);
  if (typeof ep.interval === "string" && ep.interval.trim()) {
    lines.push(`    interval: ${yamlQuote(ep.interval.trim())}`);
  }
  if (typeof ep.method === "string" && ep.method.trim()) {
    lines.push(`    method: ${yamlQuote(ep.method.trim())}`);
  }
  const conditions = Array.isArray(ep.conditions) ? ep.conditions : [];
  if (conditions.length) {
    lines.push("    conditions:");
    lines.push(yamlStringList(conditions, 6));
  }
  const client = isObject(ep.client) ? ep.client : null;
  if (client && client.insecure === true) {
    lines.push("    client:");
    lines.push("      insecure: true");
  }
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} gatus
 */
export function renderGatusConfigYaml(gatus) {
  if (!isObject(gatus)) {
    return "endpoints: []\n";
  }
  const endpoints = Array.isArray(gatus.endpoints) ? gatus.endpoints.filter(isObject) : [];
  const parts = [];
  if (endpoints.length === 0) {
    parts.push("endpoints: []");
  } else {
    parts.push("endpoints:");
    for (const ep of endpoints) {
      parts.push(renderEndpoint(/** @type {Record<string, unknown>} */ (ep)));
    }
  }
  const extra =
    typeof gatus.config_yaml_extra === "string" && gatus.config_yaml_extra.trim()
      ? gatus.config_yaml_extra.trim()
      : "";
  const mailYaml = gatusMailAlertingYaml(gatus);
  if (mailYaml && !extra.includes("alerting:")) {
    parts.push("");
    parts.push(mailYaml);
  }
  if (extra) {
    parts.push("");
    parts.push(extra);
  }
  return `${parts.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} gatus
 */
export function gatusConfigPath(gatus) {
  const p =
    typeof gatus.config_path === "string" && gatus.config_path.trim()
      ? gatus.config_path.trim()
      : "/opt/gatus/config/config.yaml";
  return p;
}

/**
 * @param {Record<string, unknown>} gatus
 */
export function gatusListenPort(gatus) {
  const port =
    typeof gatus.listen_port === "number" && Number.isFinite(gatus.listen_port)
      ? gatus.listen_port
      : Number(gatus.listen_port);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return 8080;
  return Math.trunc(port);
}
