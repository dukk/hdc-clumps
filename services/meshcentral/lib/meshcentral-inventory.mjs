/**
 * Merge live MeshCentral nodes into config meshcentral.devices[].
 */
import { configuredDevices, inferPlatformFromNode, normalizeLiveDevice } from "./meshcentral-devices.mjs";
import { allocateDeviceId } from "./meshcentral-system-inventory.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} meshcentralBlock
 * @param {Record<string, unknown>[]} liveNodes raw or normalized
 * @param {{ clientHosts?: Record<string, unknown>[] }} [opts]
 * @returns {Record<string, unknown>[]}
 */
export function mergeDevicesFromLive(meshcentralBlock, liveNodes, opts = {}) {
  const clientHosts = Array.isArray(opts.clientHosts) ? opts.clientHosts : [];
  const existing = configuredDevices(meshcentralBlock);
  /** @type {Map<string, Record<string, unknown>>} */
  const byNodeId = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const byName = new Map();
  for (const d of existing) {
    if (typeof d.node_id === "string" && d.node_id) byNodeId.set(d.node_id, d);
    if (typeof d.name === "string" && d.name) byName.set(d.name.toLowerCase(), d);
  }

  /** @type {Record<string, unknown>[]} */
  const next = [];
  /** @type {Set<string>} */
  const seenIds = new Set();
  /** @type {Set<string>} */
  const usedHdcIds = new Set(
    existing.map((d) => (typeof d.id === "string" ? d.id : "")).filter(Boolean),
  );

  for (const raw of liveNodes) {
    if (!isObject(raw)) continue;
    const node = normalizeLiveDevice(/** @type {Record<string, unknown>} */ (raw));
    const nodeId = typeof node.node_id === "string" ? node.node_id : "";
    const name = typeof node.name === "string" ? node.name : "";
    if (!nodeId && !name) continue;

    const prev =
      (nodeId && byNodeId.get(nodeId)) ||
      (name && byName.get(name.toLowerCase())) ||
      null;

    const id = allocateDeviceId({
      prev,
      live: node,
      clientHosts,
      usedHdcIds,
    });
    usedHdcIds.add(id);
    seenIds.add(id);

    const platform =
      (prev && typeof prev.platform === "string" && prev.platform !== "unknown" && prev.platform) ||
      (typeof node.platform === "string" && node.platform !== "unknown" && node.platform) ||
      inferPlatformFromNode(/** @type {Record<string, unknown>} */ (raw)) ||
      "unknown";

    next.push({
      id,
      name: name || id,
      node_id: nodeId || (prev && prev.node_id) || null,
      platform,
      managed: prev ? prev.managed !== false : true,
    });
  }

  // Preserve configured devices that were not seen live (keep node_id / managed).
  for (const d of existing) {
    const id = typeof d.id === "string" ? d.id : "";
    if (!id || seenIds.has(id)) continue;
    next.push({ ...d });
  }

  return next;
}

/**
 * Apply merged devices into a full clump config object (defaults.meshcentral.devices).
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, unknown>[]} devices
 */
export function applyDevicesToConfig(cfg, devices) {
  const next = structuredClone(cfg);
  if (!isObject(next.defaults)) next.defaults = {};
  const defaults = /** @type {Record<string, unknown>} */ (next.defaults);
  if (!isObject(defaults.meshcentral)) defaults.meshcentral = {};
  const mc = /** @type {Record<string, unknown>} */ (defaults.meshcentral);
  mc.devices = devices;
  return next;
}
