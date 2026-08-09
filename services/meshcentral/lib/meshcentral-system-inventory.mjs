/**
 * Upsert operations/inventory/systems/{physical|virtual}/*.json from MeshCentral agents + hardware collect.
 */
import { join } from "node:path";

import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import { resolveSystemSidecarWrite } from "hdc/package/hardware-inventory.mjs";
import { tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { loadManualSystemSidecar } from "hdc/package/inventory-sidecar.mjs";
import { CLIENT_PLATFORMS } from "hdc/package/clients/client-config.mjs";
import { normalizeHardwareMac } from "./meshcentral-ops.mjs";
import { slugDeviceId } from "./meshcentral-devices.mjs";

export { resolveSystemSidecarWrite } from "hdc/package/hardware-inventory.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} publicRoot
 * @returns {Record<string, unknown>[]}
 */
export function loadClientHostsFromConfigs(publicRoot) {
  /** @type {Record<string, unknown>[]} */
  const hosts = [];
  for (const platform of CLIENT_PLATFORMS) {
    const clumpRoot = join(publicRoot, "clumps", "clients", platform);
    const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { publicRoot });
    if (!loaded.ok || !isObject(loaded.data)) continue;
    const raw = loaded.data.hosts;
    if (!Array.isArray(raw)) continue;
    for (const h of raw) {
      if (!isObject(h)) continue;
      hosts.push({ ...h, _client_platform: platform });
    }
  }
  return hosts;
}

/**
 * Match a live MeshCentral device to a client host id (system_id / id).
 * @param {Record<string, unknown>} live normalized live device
 * @param {Record<string, unknown>[]} clientHosts
 * @returns {string | null}
 */
export function matchClientHostId(live, clientHosts) {
  const name = typeof live.name === "string" ? live.name.trim().toLowerCase() : "";
  const ip = typeof live.ip === "string" ? live.ip.trim() : "";

  if (name) {
    for (const h of clientHosts) {
      const id = typeof h.id === "string" ? h.id.trim() : "";
      const systemId = typeof h.system_id === "string" ? h.system_id.trim() : "";
      const hostName = typeof h.name === "string" ? h.name.trim().toLowerCase() : "";
      if (id && id.toLowerCase() === name) return systemId || id;
      if (systemId && systemId.toLowerCase() === name) return systemId;
      if (hostName && hostName === name) return systemId || id || null;
    }
  }

  if (ip) {
    for (const h of clientHosts) {
      const access = isObject(h.access) ? h.access : {};
      const nodes = Array.isArray(access.nodes) ? access.nodes : [];
      for (const n of nodes) {
        if (!isObject(n)) continue;
        if (typeof n.ip === "string" && n.ip.trim() === ip) {
          const id = typeof h.id === "string" ? h.id.trim() : "";
          const systemId = typeof h.system_id === "string" ? h.system_id.trim() : "";
          return systemId || id || null;
        }
      }
    }
  }
  return null;
}

/**
 * Prefer client host id when merging new devices (no prior devices[] match).
 * @param {Record<string, unknown>[]} clientHosts
 * @param {Record<string, unknown>} live normalized
 * @param {string} fallbackId
 */
export function preferClientDeviceId(clientHosts, live, fallbackId) {
  const matched = matchClientHostId(live, clientHosts);
  return matched || fallbackId;
}

/**
 * Union string arrays preserving order, unique.
 * @param {unknown} a
 * @param {string[]} extra
 */
function unionStrings(a, extra) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const list of [Array.isArray(a) ? a : [], extra]) {
    for (const x of list) {
      if (typeof x !== "string" || !x.trim()) continue;
      const t = x.trim();
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Merge MeshCentral facts into an existing or new system sidecar.
 * @param {object} opts
 * @param {Record<string, unknown> | null} opts.existing
 * @param {string} opts.id
 * @param {Record<string, unknown>} opts.live normalized live device (may include id)
 * @param {Record<string, unknown>[] | null} [opts.hardware]
 * @param {string | null} [opts.mac]
 * @param {string} [opts.collectedAt] ISO timestamp
 */
export function mergeSystemSidecar(opts) {
  const {
    existing,
    id,
    live,
    hardware = null,
    mac = null,
    collectedAt = new Date().toISOString(),
  } = opts;

  const prev = existing && isObject(existing) ? structuredClone(existing) : null;
  /** @type {Record<string, unknown>} */
  const next = prev
    ? prev
    : {
        schema_version: 1,
        id,
        kind: "system",
        system_class: "physical",
      };

  next.schema_version = 1;
  next.id = id;
  next.kind = "system";
  if (typeof next.system_class !== "string" || !next.system_class) {
    next.system_class = "physical";
  }

  next.tags = unionStrings(next.tags, ["client", "meshcentral"]);
  next.automation_targets = unionStrings(next.automation_targets, ["client", "meshcentral"]);
  next.last_verified = collectedAt;

  const liveIp = typeof live.ip === "string" && live.ip.trim() ? live.ip.trim() : null;
  const collectedMac = normalizeHardwareMac(mac);

  const access = isObject(next.access) ? /** @type {Record<string, unknown>} */ (next.access) : {};
  /** @type {Record<string, unknown>[]} */
  const nodes = Array.isArray(access.nodes)
    ? access.nodes.filter(isObject).map((n) => /** @type {Record<string, unknown>} */ ({ ...n }))
    : [];
  let primary = nodes[0];
  if (!primary) {
    primary = { name: "primary" };
    nodes.unshift(primary);
  }
  if (typeof primary.name !== "string" || !primary.name.trim()) primary.name = "primary";
  if (liveIp) primary.ip = liveIp;
  if (collectedMac) primary.mac = collectedMac;
  access.nodes = nodes;
  next.access = access;

  if (Array.isArray(hardware) && hardware.length) {
    next.hardware = hardware;
  }

  next.query_last = {
    source: "meshcentral",
    collected_at: collectedAt,
    node_id: typeof live.node_id === "string" ? live.node_id : null,
    name: typeof live.name === "string" ? live.name : null,
    platform: typeof live.platform === "string" ? live.platform : "unknown",
    osdesc: typeof live.osdesc === "string" ? live.osdesc : null,
    online: Boolean(live.online),
  };

  return next;
}

/**
 * Upsert system sidecars for merged MeshCentral devices.
 * @param {object} opts
 * @param {string} opts.publicRoot
 * @param {Record<string, unknown>[]} opts.mergedDevices devices[] rows (id/name/node_id/platform)
 * @param {Record<string, unknown>[]} opts.liveDevices normalized live devices
 * @param {Map<string, { hardware?: Record<string, unknown>[]; mac?: string | null; ok: boolean; message?: string }>} [opts.hardwareById]
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.dryRun]
 * @returns {{ written: { id: string; rel: string; created: boolean; hardware: boolean }[]; skipped: string[] }}
 */
export function upsertSystemSidecarsFromDevices(opts) {
  const {
    publicRoot,
    mergedDevices,
    liveDevices,
    hardwareById = new Map(),
    log = () => {},
    dryRun = false,
  } = opts;

  /** @type {Map<string, Record<string, unknown>>} */
  const liveByNodeId = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const liveByName = new Map();
  for (const d of liveDevices) {
    if (typeof d.node_id === "string" && d.node_id) liveByNodeId.set(d.node_id, d);
    if (typeof d.name === "string" && d.name) liveByName.set(d.name.toLowerCase(), d);
  }

  /** @type {{ id: string; rel: string; created: boolean; hardware: boolean }[]} */
  const written = [];
  /** @type {string[]} */
  const skipped = [];
  const collectedAt = new Date().toISOString();

  for (const dev of mergedDevices) {
    const id = typeof dev.id === "string" ? dev.id.trim() : "";
    if (!id) {
      skipped.push("(missing id)");
      continue;
    }
    const nodeId = typeof dev.node_id === "string" ? dev.node_id : "";
    const name = typeof dev.name === "string" ? dev.name : "";
    const live =
      (nodeId && liveByNodeId.get(nodeId)) ||
      (name && liveByName.get(name.toLowerCase())) ||
      {
        node_id: nodeId || null,
        name: name || id,
        platform: typeof dev.platform === "string" ? dev.platform : "unknown",
        osdesc: null,
        ip: null,
        online: false,
      };

    const hw = hardwareById.get(id);
    const existing = loadManualSystemSidecar(publicRoot, id);
    const sidecar = mergeSystemSidecar({
      existing,
      id,
      live: { ...live, platform: live.platform || dev.platform },
      hardware: hw?.ok && Array.isArray(hw.hardware) ? hw.hardware : null,
      mac: hw?.ok ? (hw.mac ?? null) : null,
      collectedAt,
    });

    const resolved = resolveSystemSidecarWrite(publicRoot, id);
    if (!dryRun) {
      writeResolvedRepoJson(resolved, sidecar);
    }
    log(
      `${dryRun ? "dry-run: would write" : "wrote"} ${resolved.rel} ` +
        `(${existing ? "update" : "create"}${hw?.ok ? ", hardware" : ""})`,
    );
    written.push({
      id,
      rel: resolved.rel,
      created: !existing,
      hardware: Boolean(hw?.ok),
    });
  }

  return { written, skipped };
}

/**
 * Stable id for a live node given existing config devices + client hosts.
 * Exported for tests / mergeDevicesFromLive integration.
 * @param {object} opts
 * @param {Record<string, unknown> | null} opts.prev existing devices[] row
 * @param {Record<string, unknown>} opts.live normalized
 * @param {Record<string, unknown>[]} opts.clientHosts
 * @param {Set<string>} opts.usedHdcIds
 */
export function allocateDeviceId(opts) {
  const { prev, live, clientHosts, usedHdcIds } = opts;
  if (prev && typeof prev.id === "string" && prev.id.trim()) {
    return prev.id.trim();
  }
  const name = typeof live.name === "string" ? live.name : "";
  let id = preferClientDeviceId(clientHosts, live, slugDeviceId(name));
  if (!usedHdcIds.has(id)) return id;
  // Client id already taken by another device — fall back to slug with suffix.
  let base = slugDeviceId(name) || "device";
  if (!usedHdcIds.has(base)) return base;
  let n = 2;
  while (usedHdcIds.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
