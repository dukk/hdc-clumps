import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr as errout } from "node:process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { repoRoot } from "hdc/cli/paths.mjs";
import {
  automatedInventoryIdFromName,
  sanitizeAutomatedInventoryId,
} from "hdc/package/automated-ids.mjs";
import { writeAutomatedInventorySidecars } from "hdc/package/automated-inventory-write.mjs";
import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import {
  classicActiveStations,
  classicRestListWithFallback,
  integrationListAllClients,
  integrationListAllDevices,
  integrationListAllNetworkOverviews,
  integrationListFirewallPolicies,
  integrationListFirewallZones,
  integrationListPendingDevices,
  integrationNetworkDetail,
} from "hdc/package/unifi-api.mjs";
import {
  createUnifiRunContext,
  fetchLivePortForwards,
  importPortForwardsToConfig,
} from "hdc/package/unifi-collect.mjs";
import {
  formatPortForwardBlock,
  inventoryPortForwardEntry,
  normalizeUnifiConfig,
  pickFields,
} from "hdc/package/unifi-config.mjs";
import { diffPortForwardSync } from "hdc/package/unifi-port-forward-sync.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const clumpRoot = join(here, "..");

/** @param {string} line */
function logUser(line) {
  errout.write(`[unifi-network] ${line}\n`);
}

/**
 * @param {string} id
 * @param {string} kind
 */
function unifiSidecarBase(id, kind) {
  return {
    schema_version: 1,
    id,
    kind,
    tags: ["unifi", "automated"],
  };
}

/** @param {string} collectedAt */
function systemSidecarBase(id, collectedAt) {
  return {
    ...unifiSidecarBase(id, "system"),
    automation_targets: [target],
    last_verified: collectedAt,
    _automated_source: target,
    _automated_at: collectedAt,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown> | undefined}
 */
function networkAccessFromQueryLast(row) {
  /** @type {Record<string, unknown>} */
  const access = {};
  const cidr =
    typeof row.ip_subnet === "string" && row.ip_subnet.trim()
      ? row.ip_subnet.trim()
      : typeof row.subnet === "string" && row.subnet.trim()
        ? row.subnet.trim()
        : "";
  if (cidr) access.cidr = cidr;
  if (row.vlan !== undefined && row.vlan !== null && String(row.vlan).trim() !== "") {
    const n = Number(row.vlan);
    access.vlan = Number.isFinite(n) ? n : row.vlan;
  } else if (row.vlanId !== undefined && row.vlanId !== null && String(row.vlanId).trim() !== "") {
    const n = Number(row.vlanId);
    access.vlan = Number.isFinite(n) ? n : row.vlanId;
  }
  if (typeof row.dhcpd_gateway === "string" && row.dhcpd_gateway.trim()) {
    access.gateway = row.dhcpd_gateway.trim();
  } else if (typeof row.gateway === "string" && row.gateway.trim()) {
    access.gateway = row.gateway.trim();
  }
  return Object.keys(access).length ? access : undefined;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Set<string>} usedIds
 * @param {string} collectedAt
 */
function buildUnifiNetworkSidecar(row, usedIds, collectedAt) {
  const id = automatedInventoryIdFromName("net", row, usedIds);
  const access = networkAccessFromQueryLast(row);
  /** @type {Record<string, unknown>} */
  const sidecar = {
    ...unifiSidecarBase(id, "network"),
    automation_targets: [target],
    last_verified: collectedAt,
    _automated_source: target,
    _automated_at: collectedAt,
    query_last: row,
  };
  if (access) sidecar.access = access;
  return sidecar;
}

/**
 * @param {Record<string, unknown>} row
 */
function normalizeClientRow(row) {
  /** @type {Record<string, unknown>} */
  const o = { ...row };
  if (typeof o.macAddress !== "string" || !o.macAddress.trim()) {
    if (typeof o.mac === "string" && o.mac.trim()) o.macAddress = o.mac.trim();
  }
  if (typeof o.ipAddress !== "string" || !o.ipAddress.trim()) {
    if (typeof o.ip === "string" && o.ip.trim()) o.ipAddress = o.ip.trim();
    else if (typeof o.last_ip === "string" && o.last_ip.trim()) o.ipAddress = o.last_ip.trim();
  }
  if (typeof o.name !== "string" || !o.name.trim()) {
    if (typeof o.hostname === "string" && o.hostname.trim()) o.name = o.hostname.trim();
    else if (typeof o.host_name === "string" && o.host_name.trim()) o.name = o.host_name.trim();
  }
  if (typeof o.id !== "string" || !o.id.trim()) {
    if (typeof o.macAddress === "string" && o.macAddress.trim()) o.id = o.macAddress.trim();
  }
  if (typeof o.type !== "string" || !o.type.trim()) {
    if (o.is_wired === true) o.type = "WIRED";
    else if (o.is_wireless === true) o.type = "WIRELESS";
  }
  return o;
}

/**
 * @param {Record<string, unknown>[]} integrationRows
 * @param {Record<string, unknown>[]} classicRows
 */
function mergeClientRowsByMac(integrationRows, classicRows) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byMac = new Map();
  const add = (/** @type {Record<string, unknown>} */ raw, /** @type {boolean} */ fillGaps) => {
    const n = normalizeClientRow(raw);
    const mac = typeof n.macAddress === "string" ? n.macAddress.trim().toLowerCase() : "";
    if (!mac) return;
    const prev = byMac.get(mac);
    if (!prev) {
      byMac.set(mac, n);
      return;
    }
    byMac.set(mac, fillGaps ? { ...n, ...prev } : { ...prev, ...n });
  };
  for (const r of classicRows) add(r, true);
  for (const r of integrationRows) add(r, false);
  return [...byMac.values()];
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} collectedAt
 * @param {Set<string>} usedIds
 */
function buildClientSystemSidecar(row, collectedAt, usedIds) {
  const mac = typeof row.macAddress === "string" ? row.macAddress.trim() : "";
  const displayName = typeof row.name === "string" ? row.name.trim() : "";
  let id;
  if (displayName) {
    id = automatedInventoryIdFromName("sys", row, usedIds);
  } else if (mac) {
    id = `sys-${sanitizeAutomatedInventoryId(mac)}`;
    usedIds.add(id);
  } else {
    id = automatedInventoryIdFromName("sys", { name: "unknown-client" }, usedIds);
  }
  const nodeName = displayName || id;
  /** @type {Record<string, unknown>} */
  const node = { name: nodeName };
  if (typeof row.ipAddress === "string" && row.ipAddress.trim()) node.ip = row.ipAddress.trim();
  if (mac) node.mac = mac;
  const entry = inventoryClientEntry({ ...row, collected_at: collectedAt }, collectedAt);
  return {
    schema_version: 1,
    id,
    kind: "system",
    tags: ["unifi", "automated", "unifi-client"],
    automation_targets: [target],
    last_verified: collectedAt,
    _automated_source: target,
    _automated_at: collectedAt,
    access: { nodes: [node] },
    query_last: entry,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} collectedAt
 * @param {string} roleTag
 */
function buildUnifiSystemSidecar(row, collectedAt, roleTag) {
  const rawId =
    typeof row.id === "string"
      ? row.id
      : typeof row._id === "string"
        ? row._id
        : typeof row.macAddress === "string"
          ? row.macAddress
          : "unknown";
  const id = `unifi-${roleTag}-${sanitizeAutomatedInventoryId(String(rawId))}`;
  const name = typeof row.name === "string" ? row.name : id;
  const ip = typeof row.ipAddress === "string" ? row.ipAddress : "";
  const mac = typeof row.macAddress === "string" ? row.macAddress : "";
  /** @type {Record<string, unknown>} */
  const node = { name };
  if (ip) node.ip = ip;
  if (mac) node.mac = mac;
  return {
    ...systemSidecarBase(id, collectedAt),
    tags: ["unifi", "automated", roleTag],
    access: { nodes: [node] },
    query_last: row,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {"firewall_policy" | "port_forward"} policyClass
 * @param {Set<string>} usedIds
 * @param {string} collectedAt
 */
function buildUnifiPolicySidecar(row, policyClass, usedIds, collectedAt) {
  const prefix = policyClass === "port_forward" ? "pf" : "fw";
  const id = automatedInventoryIdFromName(prefix, row, usedIds);
  return {
    ...unifiSidecarBase(id, "policy"),
    automation_targets: [target],
    last_verified: collectedAt,
    _automated_source: target,
    _automated_at: collectedAt,
    policy_class: policyClass,
    query_last: row,
  };
}

/**
 * @param {string} base
 * @param {string} apiKey
 * @param {string} integrationSiteId
 * @param {string} classicSiteKey
 * @param {boolean} rejectUnauthorized
 */
async function listConnectedClients(base, apiKey, integrationSiteId, classicSiteKey, rejectUnauthorized) {
  /** @type {Record<string, unknown>[]} */
  let integrationRows = [];
  try {
    integrationRows = await integrationListAllClients(base, apiKey, integrationSiteId, rejectUnauthorized);
  } catch (e) {
    errout.write(`[unifi-network] Integration client list failed (${/** @type {Error} */ (e).message}).\n`);
  }

  /** @type {Record<string, unknown>[]} */
  let classicRows = [];
  try {
    classicRows = await classicActiveStations(base, apiKey, classicSiteKey, rejectUnauthorized);
    if (!classicRows.length && classicSiteKey !== "default") {
      classicRows = await classicActiveStations(base, apiKey, "default", rejectUnauthorized);
    }
  } catch (e) {
    errout.write(`[unifi-network] Classic stat/sta failed (${/** @type {Error} */ (e).message}).\n`);
  }

  const merged = mergeClientRowsByMac(integrationRows, classicRows);
  if (integrationRows.length && classicRows.length && merged.length > integrationRows.length) {
    logUser(
      `Merged ${integrationRows.length} integration client(s) with classic stat/sta (${classicRows.length} row(s)) → ${merged.length} unique by MAC.`,
    );
  } else if (!integrationRows.length && classicRows.length) {
    logUser(`Using ${merged.length} client(s) from classic stat/sta (integration list was empty).`);
  }
  return merged;
}

const CLASSIC_EXPORT_KEYS = new Set([
  "_id",
  "name",
  "purpose",
  "vlan",
  "vlan_enabled",
  "enabled",
  "ip_subnet",
  "dhcpd_enabled",
  "dhcpd_start",
  "dhcpd_stop",
  "dhcpd_gateway",
  "dhcpd_ip_1",
  "dhcpd_ip_2",
  "dhcpd_ip_3",
  "domain_name",
  "dhcpd_dns_enabled",
  "dhcp_relay_server",
  "dhcpd_leasetime",
  "dhcpdv6_enabled",
  "dhcpd_wins_enabled",
  "dhcpd_wins_server",
  "ipv6_interface_type",
  "ipv6_ra_enabled",
  "networkgroup",
]);

/**
 * @param {Record<string, unknown>} n
 */
function sanitizeClassicRow(n) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of CLASSIC_EXPORT_KEYS) {
    if (n[k] !== undefined) out[k] = n[k];
  }
  return out;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} collectedAt
 */
function inventoryNetworkEntry(row, collectedAt) {
  const dns = [row.dhcpd_ip_1, row.dhcpd_ip_2, row.dhcpd_ip_3].filter((x) => typeof x === "string" && x.trim());
  return {
    ...sanitizeClassicRow(row),
    dns_servers: dns,
    collected_at: collectedAt,
  };
}

/**
 * @param {Record<string, unknown>} row
 */
function formatNetworkBlock(row) {
  const lines = [];
  const name = typeof row.name === "string" ? row.name : "(unnamed)";
  const purpose = typeof row.purpose === "string" ? row.purpose : "";
  lines.push(`— ${name}${purpose ? ` [${purpose}]` : ""}`);
  if (row.vlan !== undefined) lines.push(`  VLAN: ${String(row.vlan)} (vlan_enabled: ${String(row.vlan_enabled ?? "")})`);
  if (typeof row.ip_subnet === "string" && row.ip_subnet) lines.push(`  Subnet / CIDR: ${row.ip_subnet}`);
  if (row.dhcpd_enabled !== undefined) lines.push(`  DHCP server: ${row.dhcpd_enabled ? "on" : "off"}`);
  if (typeof row.dhcpd_start === "string" && typeof row.dhcpd_stop === "string") {
    lines.push(`  DHCP pool: ${row.dhcpd_start} – ${row.dhcpd_stop}`);
  }
  if (typeof row.dhcpd_gateway === "string" && row.dhcpd_gateway) lines.push(`  DHCP gateway: ${row.dhcpd_gateway}`);
  const dns = [row.dhcpd_ip_1, row.dhcpd_ip_2, row.dhcpd_ip_3].filter((x) => typeof x === "string" && x.trim());
  if (dns.length) lines.push(`  DNS (DHCP options): ${dns.join(", ")}`);
  if (typeof row.domain_name === "string" && row.domain_name) lines.push(`  Domain: ${row.domain_name}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} merged
 */
function formatIntegrationNetworkBlock(merged) {
  const lines = [];
  const name = typeof merged.name === "string" ? merged.name : "(unnamed)";
  lines.push(`— ${name} (Integration API — no L3/DNS in this view)`);
  lines.push(`  id: ${String(merged.id ?? "")}`);
  if (merged.vlanId !== undefined) lines.push(`  vlanId: ${String(merged.vlanId)}`);
  if (merged.management !== undefined) lines.push(`  management: ${String(merged.management)}`);
  if (merged.enabled !== undefined) lines.push(`  enabled: ${String(merged.enabled)}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} overview
 * @param {Record<string, unknown>} detail
 * @param {string} collectedAt
 */
function inventoryIntegrationNetworkEntry(overview, detail, collectedAt) {
  const o = overview && typeof overview === "object" ? overview : {};
  const d = detail && typeof detail === "object" ? detail : {};
  return {
    source_api: "integration",
    id: typeof o.id === "string" ? o.id : typeof d.id === "string" ? d.id : null,
    name: typeof o.name === "string" ? o.name : typeof d.name === "string" ? d.name : null,
    enabled: typeof o.enabled === "boolean" ? o.enabled : typeof d.enabled === "boolean" ? d.enabled : null,
    vlanId: typeof o.vlanId === "number" ? o.vlanId : typeof d.vlanId === "number" ? d.vlanId : o.vlanId ?? d.vlanId,
    management: typeof o.management === "string" ? o.management : typeof d.management === "string" ? d.management : null,
    metadata: d.metadata ?? o.metadata ?? null,
    collected_at: collectedAt,
  };
}

const DEVICE_EXPORT_KEYS = new Set([
  "id",
  "macAddress",
  "ipAddress",
  "name",
  "model",
  "state",
  "supported",
  "firmwareVersion",
  "firmwareUpdatable",
  "features",
  "interfaces",
]);

const CLIENT_EXPORT_KEYS = new Set([
  "id",
  "type",
  "name",
  "macAddress",
  "ipAddress",
  "connectedAt",
  "access",
  "uplinkDeviceId",
]);

const PENDING_DEVICE_EXPORT_KEYS = new Set([
  "macAddress",
  "ipAddress",
  "model",
  "state",
  "supported",
  "firmwareVersion",
  "firmwareUpdatable",
  "features",
]);

/**
 * @param {Record<string, unknown>} row
 * @param {string} collectedAt
 */
function inventoryDeviceEntry(row, collectedAt) {
  return { ...pickFields(row, DEVICE_EXPORT_KEYS), collected_at: collectedAt };
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} collectedAt
 */
function inventoryClientEntry(row, collectedAt) {
  return { ...pickFields(row, CLIENT_EXPORT_KEYS), collected_at: collectedAt };
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} collectedAt
 */
function inventoryPendingDeviceEntry(row, collectedAt) {
  return { ...pickFields(row, PENDING_DEVICE_EXPORT_KEYS), collected_at: collectedAt };
}

/**
 * @param {Record<string, unknown>} row
 */
function formatDeviceBlock(row) {
  const lines = [];
  const name = typeof row.name === "string" ? row.name : "(unnamed)";
  const model = typeof row.model === "string" ? row.model : "";
  const state = typeof row.state === "string" ? row.state : "";
  lines.push(`— ${name}${model ? ` (${model})` : ""}${state ? ` · ${state}` : ""}`);
  if (typeof row.ipAddress === "string" && row.ipAddress) lines.push(`  IP: ${row.ipAddress}`);
  if (typeof row.macAddress === "string" && row.macAddress) lines.push(`  MAC: ${row.macAddress}`);
  if (typeof row.firmwareVersion === "string" && row.firmwareVersion) {
    const upd = row.firmwareUpdatable ? " (update available)" : "";
    lines.push(`  Firmware: ${row.firmwareVersion}${upd}`);
  }
  if (Array.isArray(row.features) && row.features.length) lines.push(`  Features: ${row.features.join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} row
 */
function formatClientBlock(row) {
  const lines = [];
  const name = typeof row.name === "string" ? row.name : "(unnamed)";
  const type = typeof row.type === "string" ? row.type : "";
  lines.push(`— ${name}${type ? ` [${type}]` : ""}`);
  if (typeof row.ipAddress === "string" && row.ipAddress) lines.push(`  IP: ${row.ipAddress}`);
  if (typeof row.macAddress === "string" && row.macAddress) lines.push(`  MAC: ${row.macAddress}`);
  if (typeof row.connectedAt === "string" && row.connectedAt) lines.push(`  Connected: ${row.connectedAt}`);
  const access = row.access && typeof row.access === "object" && !Array.isArray(row.access) ? row.access : null;
  if (access && typeof access.type === "string") {
    const auth = typeof access.authorized === "boolean" ? ` authorized=${access.authorized}` : "";
    lines.push(`  Access: ${access.type}${auth}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} row
 */
function formatPendingDeviceBlock(row) {
  const lines = [];
  const model = typeof row.model === "string" ? row.model : "";
  const state = typeof row.state === "string" ? row.state : "";
  const label = typeof row.macAddress === "string" ? row.macAddress : "(unknown)";
  lines.push(`— ${label}${model ? ` (${model})` : ""}${state ? ` · ${state}` : ""}`);
  if (typeof row.ipAddress === "string" && row.ipAddress) lines.push(`  IP: ${row.ipAddress}`);
  lines.push("");
  return lines.join("\n");
}

const FIREWALL_ZONE_EXPORT_KEYS = new Set(["id", "name", "networkIds", "metadata"]);

const FIREWALL_POLICY_EXPORT_KEYS = new Set([
  "id",
  "enabled",
  "name",
  "description",
  "index",
  "action",
  "source",
  "destination",
  "ipProtocolScope",
  "connectionStateFilter",
  "ipsecFilter",
  "loggingEnabled",
  "schedule",
  "metadata",
]);

/**
 * @param {Record<string, unknown>[]} zones
 * @returns {Map<string, string>}
 */
function firewallZoneNameMap(zones) {
  /** @type {Map<string, string>} */
  const m = new Map();
  for (const z of zones) {
    const id = typeof z.id === "string" ? z.id : "";
    const name = typeof z.name === "string" ? z.name : "";
    if (id && name) m.set(id, name);
  }
  return m;
}

/**
 * @param {unknown} endpoint
 * @param {Map<string, string>} zoneMap
 */
function formatFirewallEndpoint(endpoint, zoneMap) {
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return "?";
  const ep = /** @type {Record<string, unknown>} */ (endpoint);
  const zid = typeof ep.firewallZoneId === "string" ? ep.firewallZoneId : "";
  if (zid && zoneMap.has(zid)) return zoneMap.get(zid) ?? zid;
  return zid || "?";
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} collectedAt
 */
function inventoryFirewallZoneEntry(row, collectedAt) {
  return { ...pickFields(row, FIREWALL_ZONE_EXPORT_KEYS), collected_at: collectedAt };
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} collectedAt
 */
function inventoryFirewallPolicyEntry(row, collectedAt) {
  return { ...pickFields(row, FIREWALL_POLICY_EXPORT_KEYS), collected_at: collectedAt };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Map<string, string>} zoneMap
 */
function formatFirewallPolicyBlock(row, zoneMap) {
  const lines = [];
  const name = typeof row.name === "string" ? row.name : "(unnamed)";
  const enabled = row.enabled === false ? "disabled" : "enabled";
  const idx = row.index !== undefined ? ` #${String(row.index)}` : "";
  lines.push(`— ${name}${idx} (${enabled})`);
  const action =
    row.action && typeof row.action === "object" && !Array.isArray(row.action)
      ? /** @type {Record<string, unknown>} */ (row.action)
      : null;
  if (action && typeof action.type === "string") lines.push(`  Action: ${action.type}`);
  lines.push(
    `  ${formatFirewallEndpoint(row.source, zoneMap)} → ${formatFirewallEndpoint(row.destination, zoneMap)}`,
  );
  const scope =
    row.ipProtocolScope && typeof row.ipProtocolScope === "object" && !Array.isArray(row.ipProtocolScope)
      ? /** @type {Record<string, unknown>} */ (row.ipProtocolScope)
      : null;
  if (scope && scope.ipVersion !== undefined) lines.push(`  IP scope: ${String(scope.ipVersion)}`);
  if (row.loggingEnabled === true) lines.push("  Logging: on");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const t0 = Date.now();
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const importPortForwards = flags["import-port-forwards"] === "1";
  const exportInventory = flags["export-inventory"] === "1";
  const prune = flags.prune === "1";
  const yes = flags.yes === "1";

  logUser(`query starting (cwd: ${process.cwd().replace(/\\/g, "/")})`);
  logUser(`clump root: ${clumpRoot.replace(/\\/g, "/")}`);
  if (importPortForwards) {
    logUser("import-port-forwards: will replace port_forwards[] in config.json with live snapshot.");
  }
  if (exportInventory) {
    logUser(
      `export-inventory: will write operations/automated/{networks,systems,policies}/*.json${prune ? " (with prune)" : ""}.`,
    );
  }

  const ctx = await createUnifiRunContext({
    clumpRoot,
    log: logUser,
    bootstrapFromExample: importPortForwards,
  });
  const { base, apiKey, rejectUnauthorized } = ctx;
  const integrationSiteId = ctx.siteId;
  let classicSiteKey = ctx.classicSiteKey;

  /** @type {Record<string, unknown>[]} */
  let rows = [];
  /** @type {"classic" | "integration"} */
  let dataSource = "classic";

  logUser(`Fetching networks via classic API: GET …/api/s/${classicSiteKey}/rest/networkconf …`);
  try {
    const net = await classicRestListWithFallback(base, apiKey, classicSiteKey, "networkconf", rejectUnauthorized);
    classicSiteKey = net.siteKey;
    rows = net.rows;
    logUser(`Classic networkconf parsed: ${rows.length} network row(s) (site key "${classicSiteKey}").`);
  } catch (e) {
    errout.write(
      `[unifi-network] Classic networkconf failed (${/** @type {Error} */ (e).message}).\n`,
    );
  }

  const collectedAt = new Date().toISOString();
  /** @type {Record<string, unknown>[]} */
  let networks = [];

  if (rows.length) {
    networks = rows.map((r) => inventoryNetworkEntry(r, collectedAt));
  } else {
    dataSource = "integration";
    logUser("Classic API produced no networks; falling back to Integration API (VLAN/name/enabled; subnets/DNS need classic).");
    logUser(`Listing networks: GET …/integration/v1/sites/${integrationSiteId}/networks (paginated) …`);
    const overviews = await integrationListAllNetworkOverviews(base, apiKey, integrationSiteId, rejectUnauthorized);
    logUser(`Integration API listed ${overviews.length} network(s).`);
    if (!overviews.length) {
      errout.write("[unifi-network] No networks from Integration API either.\n");
      process.exitCode = 1;
      return;
    }
    logUser(`Fetching per-network details (${overviews.length}) …`);
    let i = 0;
    for (const ov of overviews) {
      i += 1;
      if (i === 1 || i === overviews.length || i % 10 === 0) {
        logUser(`  network detail progress: ${i}/${overviews.length}`);
      }
      const id = typeof ov.id === "string" ? ov.id : "";
      let detail = /** @type {Record<string, unknown>} */ ({});
      if (id) {
        try {
          const d = await integrationNetworkDetail(base, apiKey, integrationSiteId, id, rejectUnauthorized);
          if (d && typeof d === "object" && !Array.isArray(d)) detail = /** @type {Record<string, unknown>} */ (d);
        } catch {
          /* overview only */
        }
      }
      networks.push(inventoryIntegrationNetworkEntry(ov, detail, collectedAt));
      const merged = { ...ov, ...detail };
      rows.push(merged);
    }
    logUser("Integration API detail pass complete.");
  }

  /** @type {Record<string, unknown>[]} */
  let deviceRows = [];
  /** @type {Record<string, unknown>[]} */
  let clientRows = [];
  /** @type {Record<string, unknown>[]} */
  let pendingDeviceRows = [];

  logUser(`Listing adopted equipment: GET …/integration/v1/sites/${integrationSiteId}/devices (paginated) …`);
  try {
    deviceRows = await integrationListAllDevices(base, apiKey, integrationSiteId, rejectUnauthorized);
    logUser(`Adopted devices: ${deviceRows.length}.`);
  } catch (e) {
    errout.write(`[unifi-network] Device list failed (${/** @type {Error} */ (e).message}).\n`);
  }

  logUser(
    `Listing connected clients: integration GET …/sites/${integrationSiteId}/clients and classic POST …/stat/sta …`,
  );
  try {
    clientRows = await listConnectedClients(base, apiKey, integrationSiteId, classicSiteKey, rejectUnauthorized);
    logUser(`Connected clients (unique by MAC): ${clientRows.length}.`);
  } catch (e) {
    errout.write(`[unifi-network] Client list failed (${/** @type {Error} */ (e).message}).\n`);
  }

  logUser("Listing devices pending adoption: GET …/integration/v1/pending-devices (paginated) …");
  try {
    pendingDeviceRows = await integrationListPendingDevices(base, apiKey, rejectUnauthorized);
    logUser(`Pending adoption: ${pendingDeviceRows.length} device(s).`);
  } catch (e) {
    errout.write(`[unifi-network] Pending-devices list failed (${/** @type {Error} */ (e).message}).\n`);
  }

  const devices = deviceRows.map((r) => inventoryDeviceEntry(r, collectedAt));
  const pending_devices = pendingDeviceRows.map((r) => inventoryPendingDeviceEntry(r, collectedAt));

  /** @type {Record<string, unknown>[]} */
  let firewallZoneRows = [];
  /** @type {Record<string, unknown>[]} */
  let firewallPolicyRows = [];

  logUser(`Listing firewall zones: GET …/integration/v1/sites/${integrationSiteId}/firewall/zones …`);
  try {
    firewallZoneRows = await integrationListFirewallZones(base, apiKey, integrationSiteId, rejectUnauthorized);
    logUser(`Firewall zones: ${firewallZoneRows.length}.`);
  } catch (e) {
    errout.write(`[unifi-network] Firewall zone list failed (${/** @type {Error} */ (e).message}).\n`);
  }

  logUser(`Listing firewall policies: GET …/integration/v1/sites/${integrationSiteId}/firewall/policies …`);
  try {
    firewallPolicyRows = await integrationListFirewallPolicies(base, apiKey, integrationSiteId, rejectUnauthorized);
    logUser(`Firewall policies: ${firewallPolicyRows.length}.`);
  } catch (e) {
    errout.write(`[unifi-network] Firewall policy list failed (${/** @type {Error} */ (e).message}).\n`);
  }

  /** @type {Record<string, unknown>[]} */
  let portForwardRows = [];
  /** @type {Error | null} */
  let portForwardFetchError = null;
  try {
    portForwardRows = await fetchLivePortForwards(ctx, logUser);
    classicSiteKey = ctx.classicSiteKey;
  } catch (e) {
    portForwardFetchError = e instanceof Error ? e : new Error(String(e));
    errout.write(`[unifi-network] Port forward list failed (${portForwardFetchError.message}).\n`);
  }

  const port_forward_sync = diffPortForwardSync(ctx.config.managedPortForwards, portForwardRows);

  /** @type {{ imported_count: number; config_rel: string } | null} */
  let importResult = null;
  if (importPortForwards) {
    if (portForwardFetchError) {
      errout.write("[unifi-network] Aborted: cannot import port forwards after API failure.\n");
      process.exitCode = 1;
      return;
    }
    if (!yes) {
      const rl = createInterface({ input, output: errout });
      try {
        const ans = await rl.question(
          `[unifi-network] Replace port_forwards[] in config with ${portForwardRows.length} live rule(s)? [y/N] `,
        );
        if (!/^y(es)?$/i.test(ans.trim())) {
          errout.write("Aborted: import not confirmed (use --yes to skip prompt).\n");
          process.exitCode = 1;
          return;
        }
      } finally {
        rl.close();
      }
    }
    const written = importPortForwardsToConfig({ clumpRoot, liveRows: portForwardRows, log: logUser });
    importResult = { imported_count: written.imported.length, config_rel: written.configRel };
    ctx.config = normalizeUnifiConfig({ ...ctx.cfgRaw, port_forwards: written.imported });
  }

  const firewall_zones = firewallZoneRows.map((r) => inventoryFirewallZoneEntry(r, collectedAt));
  const firewall_policies = firewallPolicyRows.map((r) => inventoryFirewallPolicyEntry(r, collectedAt));
  const port_forwards = portForwardRows.map((r) => inventoryPortForwardEntry(r, collectedAt));
  const zoneMap = firewallZoneNameMap(firewallZoneRows);

  logUser("Building structured records for stdout JSON …");
  /** @type {Set<string>} */
  const usedNetworkIds = new Set();
  /** @type {Set<string>} */
  const usedPolicyIds = new Set();
  /** @type {Set<string>} */
  const usedClientSystemIds = new Set();

  /** @type {Record<string, unknown>[]} */
  const networkRecords = [];
  for (const n of networks) {
    networkRecords.push(buildUnifiNetworkSidecar(n, usedNetworkIds, collectedAt));
  }

  /** @type {Record<string, unknown>[]} */
  const deviceSystemRecords = deviceRows.map((r) => buildUnifiSystemSidecar(r, collectedAt, "device"));
  /** @type {Record<string, unknown>[]} */
  const clientSystemRecords = [];
  for (const row of clientRows) {
    clientSystemRecords.push(buildClientSystemSidecar(row, collectedAt, usedClientSystemIds));
  }
  /** @type {Record<string, unknown>[]} */
  const pendingSystemRecords = pendingDeviceRows.map((r) => buildUnifiSystemSidecar(r, collectedAt, "pending"));

  /** @type {Record<string, unknown>[]} */
  const firewallPolicyRecords = [];
  for (const fp of firewall_policies) {
    firewallPolicyRecords.push(buildUnifiPolicySidecar(fp, "firewall_policy", usedPolicyIds, collectedAt));
  }
  /** @type {Record<string, unknown>[]} */
  const portForwardRecords = [];
  for (const pf of port_forwards) {
    portForwardRecords.push(buildUnifiPolicySidecar(pf, "port_forward", usedPolicyIds, collectedAt));
  }

  /** @type {Record<string, unknown>[]} */
  const systemRecords = [...deviceSystemRecords, ...clientSystemRecords, ...pendingSystemRecords];
  /** @type {Record<string, unknown>[]} */
  const policyRecords = [...firewallPolicyRecords, ...portForwardRecords];

  /** @type {{
   *   written: number;
   *   pruned: number;
   *   paths: string[];
   *   by_category: Record<string, { written: number; pruned: number }>;
   * } | null} */
  let exportInventoryResult = null;
  if (exportInventory) {
    const total =
      networkRecords.length + systemRecords.length + policyRecords.length;
    if (!yes) {
      const rl = createInterface({ input, output: errout });
      try {
        const pruneNote = prune ? " and prune stale UniFi automated sidecars" : "";
        const ans = await rl.question(
          `[unifi-network] Write ${total} automated sidecar(s) under operations/automated/{networks,systems,policies}/${pruneNote}? [y/N] `,
        );
        if (!/^y(es)?$/i.test(ans.trim())) {
          errout.write("[unifi-network] Aborted: export-inventory not confirmed (use --yes).\n");
          process.exitCode = 1;
          return;
        }
      } finally {
        rl.close();
      }
    }
    const root = repoRoot();
    const writeOpts = {
      backendId: target,
      prune,
      log: { info: (/** @type {string} */ s) => logUser(s) },
    };
    const netOut = writeAutomatedInventorySidecars(root, networkRecords, {
      ...writeOpts,
      category: "networks",
    });
    const sysOut = writeAutomatedInventorySidecars(root, systemRecords, {
      ...writeOpts,
      category: "systems",
    });
    const polOut = writeAutomatedInventorySidecars(root, policyRecords, {
      ...writeOpts,
      category: "policies",
    });
    exportInventoryResult = {
      written: netOut.written + sysOut.written + polOut.written,
      pruned: netOut.pruned + sysOut.pruned + polOut.pruned,
      paths: [...netOut.paths, ...sysOut.paths, ...polOut.paths],
      by_category: {
        networks: { written: netOut.written, pruned: netOut.pruned },
        systems: { written: sysOut.written, pruned: sysOut.pruned },
        policies: { written: polOut.written, pruned: polOut.pruned },
      },
    };
    logUser(
      `export-inventory complete: ${exportInventoryResult.written} written, ${exportInventoryResult.pruned} pruned`,
    );
  }

  logUser(
    `Prepared stdout payload: ${networkRecords.length} network record(s), ${deviceSystemRecords.length} device system(s), ${clientSystemRecords.length} client system(s), ${pendingSystemRecords.length} pending, ${firewallPolicyRecords.length} firewall policy record(s), ${portForwardRecords.length} port-forward record(s).`,
  );

  errout.write(`\n[unifi-network] — Network summary (${dataSource}) —\n`);
  errout.write(
    `Controller ${base} · integration site ${integrationSiteId} · classic site ${classicSiteKey} · ${networks.length} network(s)\n\n`,
  );
  for (const r of rows) {
    errout.write(dataSource === "classic" ? formatNetworkBlock(r) : formatIntegrationNetworkBlock(r));
  }

  if (deviceRows.length) {
    const online = deviceRows.filter((d) => d.state === "ONLINE").length;
    errout.write(`\n[unifi-network] — Adopted equipment (${deviceRows.length}, ${online} online) —\n\n`);
    for (const d of deviceRows) errout.write(formatDeviceBlock(d));
  }

  if (clientRows.length) {
    errout.write(`\n[unifi-network] — Connected clients (${clientRows.length}) —\n\n`);
    for (const c of clientRows) errout.write(formatClientBlock(c));
  }

  if (pendingDeviceRows.length) {
    errout.write(`\n[unifi-network] — Pending adoption (${pendingDeviceRows.length}) —\n\n`);
    for (const p of pendingDeviceRows) errout.write(formatPendingDeviceBlock(p));
  }

  if (firewallPolicyRows.length) {
    const enabled = firewallPolicyRows.filter((p) => p.enabled !== false).length;
    errout.write(`\n[unifi-network] — Firewall policies (${firewallPolicyRows.length}, ${enabled} enabled) —\n\n`);
    for (const p of firewallPolicyRows) errout.write(formatFirewallPolicyBlock(p, zoneMap));
  }

  if (portForwardRows.length) {
    const enabledPf = portForwardRows.filter((p) => p.enabled !== false).length;
    errout.write(`\n[unifi-network] — Port forwarding (${portForwardRows.length}, ${enabledPf} enabled) —\n\n`);
    for (const p of portForwardRows) errout.write(formatPortForwardBlock(p));
  }

  if (port_forward_sync.summary) {
    errout.write(
      `\n[unifi-network] — Port forward diff vs config (managed) — create ${port_forward_sync.summary.create}, update ${port_forward_sync.summary.update}, delete ${port_forward_sync.summary.delete}, unchanged ${port_forward_sync.summary.unchanged}\n`,
    );
    if (port_forward_sync.error) {
      errout.write(`[unifi-network] Diff error: ${port_forward_sync.error}\n`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logUser(`Finished in ${elapsed}s. JSON summary on stdout for hdc.`);

  const payload = {
    target,
    verb: "query",
    ok: true,
    collected_at: collectedAt,
    controller_base_url: base,
    site_id: integrationSiteId,
    classic_site_key: classicSiteKey,
    data_source: dataSource,
    network_count: networks.length,
    device_count: devices.length,
    client_count: clientSystemRecords.length,
    pending_device_count: pending_devices.length,
    firewall_zone_count: firewall_zones.length,
    firewall_policy_count: firewall_policies.length,
    port_forward_count: port_forwards.length,
    port_forward_sync: {
      summary: port_forward_sync.summary,
      error: port_forward_sync.error ?? null,
    },
    import: importResult,
    export_inventory: exportInventoryResult,
    firewall_zones,
    network_records: networkRecords,
    device_system_records: deviceSystemRecords,
    client_system_records: clientSystemRecords,
    pending_system_records: pendingSystemRecords,
    firewall_policy_records: firewallPolicyRecords,
    port_forward_records: portForwardRecords,
    message:
      "UniFi snapshot from live API. Use query --export-inventory to write automated sidecars; --import-port-forwards bootstraps port_forwards[] in config.json; maintain applies managed rules.",
    systems: systemRecords,
  };
  output.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((e) => {
  errout.write(`[unifi-network] Fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.exitCode = 1;
});
