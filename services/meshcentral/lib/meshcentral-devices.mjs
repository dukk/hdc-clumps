/**
 * Normalize and resolve MeshCentral device nodes against config devices[].
 */

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Infer platform from MeshCentral node metadata.
 * @param {Record<string, unknown>} node
 * @returns {"windows" | "linux" | "unknown"}
 */
export function inferPlatformFromNode(node) {
  const bits = [
    typeof node.osdesc === "string" ? node.osdesc : "",
    typeof node.os === "string" ? node.os : "",
    typeof node.name === "string" ? node.name : "",
  ]
    .join(" ")
    .toLowerCase();
  if (/\bwindows\b|\bwin\s*1[01]\b|\bwin32\b|\bmicrosoft\b/.test(bits)) return "windows";
  if (/\blinux\b|\bubuntu\b|\bdebian\b|\braspberry\b|\bfedora\b|\bcentos\b|\brhel\b/.test(bits)) {
    return "linux";
  }
  const agents = node.agent;
  if (isObject(agents)) {
    const id = typeof agents.id === "number" ? agents.id : Number(agents.id);
    // Common MeshCentral agent type ids (approximate): 1–4 Windows, 5+ Linux/BSD variants.
    if (Number.isFinite(id) && id >= 1 && id <= 4) return "windows";
    if (Number.isFinite(id) && id >= 5 && id <= 40) return "linux";
  }
  return "unknown";
}

/**
 * @param {Record<string, unknown>} node
 * @returns {Record<string, unknown>}
 */
export function normalizeLiveDevice(node) {
  const nodeId = typeof node._id === "string" ? node._id : typeof node.id === "string" ? node.id : "";
  const name = typeof node.name === "string" ? node.name.trim() : "";
  const ip =
    typeof node.host === "string"
      ? node.host
      : typeof node.ip === "string"
        ? node.ip
        : Array.isArray(node.ip) && typeof node.ip[0] === "string"
          ? node.ip[0]
          : null;
  const conn = typeof node.conn === "number" ? node.conn : Number(node.conn) || 0;
  const pwr = typeof node.pwr === "number" ? node.pwr : Number(node.pwr) || 0;
  const platform = inferPlatformFromNode(node);
  return {
    node_id: nodeId,
    name,
    meshid: typeof node.meshid === "string" ? node.meshid : null,
    ip,
    connected: conn > 0,
    conn,
    power: pwr,
    online: conn > 0,
    platform,
    osdesc: typeof node.osdesc === "string" ? node.osdesc : null,
  };
}

/**
 * @param {Record<string, unknown>} meshcentral
 * @returns {Record<string, unknown>[]}
 */
export function configuredDevices(meshcentral) {
  const raw = meshcentral.devices;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject);
}

/**
 * Slug a MeshCentral device name into a stable hdc id candidate.
 * @param {string} name
 */
export function slugDeviceId(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "device";
}

/**
 * Resolve one or more device selectors (id, name, or node_id) against live + config.
 * @param {object} opts
 * @param {Record<string, unknown>[]} opts.liveDevices normalized live devices
 * @param {Record<string, unknown>[]} opts.configDevices
 * @param {string[]} opts.selectors
 * @returns {{ ok: true; devices: Record<string, unknown>[] } | { ok: false; message: string }}
 */
export function resolveDevices(opts) {
  const { liveDevices, configDevices, selectors } = opts;
  if (!selectors.length) {
    return { ok: false, message: "no --device selector provided" };
  }

  /** @type {Record<string, unknown>[]} */
  const found = [];
  /** @type {string[]} */
  const missing = [];

  for (const raw of selectors) {
    const sel = String(raw || "").trim();
    if (!sel) continue;
    const selLower = sel.toLowerCase();

    const cfg = configDevices.find(
      (d) =>
        (typeof d.id === "string" && d.id.toLowerCase() === selLower) ||
        (typeof d.name === "string" && d.name.toLowerCase() === selLower) ||
        (typeof d.node_id === "string" && d.node_id === sel),
    );

    let live =
      liveDevices.find((d) => typeof d.node_id === "string" && d.node_id === sel) ||
      liveDevices.find((d) => typeof d.name === "string" && d.name.toLowerCase() === selLower) ||
      null;

    if (!live && cfg && typeof cfg.node_id === "string" && cfg.node_id) {
      live = liveDevices.find((d) => d.node_id === cfg.node_id) || null;
    }
    if (!live && cfg && typeof cfg.name === "string") {
      const n = cfg.name.toLowerCase();
      live = liveDevices.find((d) => typeof d.name === "string" && d.name.toLowerCase() === n) || null;
    }

    if (!live && !cfg) {
      missing.push(sel);
      continue;
    }

    const platform =
      (cfg && typeof cfg.platform === "string" && cfg.platform) ||
      (live && live.platform) ||
      "unknown";

    found.push({
      id: (cfg && typeof cfg.id === "string" && cfg.id) || (live && slugDeviceId(String(live.name))) || sel,
      name: (live && live.name) || (cfg && cfg.name) || sel,
      node_id: (live && live.node_id) || (cfg && cfg.node_id) || null,
      platform,
      online: live ? Boolean(live.online) : false,
      connected: live ? Boolean(live.connected) : false,
      power: live ? live.power : null,
      ip: live ? live.ip : null,
      osdesc: live ? live.osdesc : null,
      managed: cfg ? cfg.managed !== false : true,
      live: live || null,
      config: cfg || null,
    });
  }

  if (missing.length) {
    return { ok: false, message: `unknown device(s): ${missing.join(", ")}` };
  }
  return { ok: true, devices: found };
}

/**
 * Parse --device flag value(s) into selectors (comma-separated + repeats).
 * @param {Record<string, string>} flags
 * @param {string[]} argv
 */
export function parseDeviceSelectors(flags, argv = []) {
  /** @type {string[]} */
  const out = [];
  const single = flags.device;
  if (typeof single === "string" && single && single !== "1") {
    for (const part of single.split(",")) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  // Collect repeated --device values from raw argv (parseArgvFlags last-wins).
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--device" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      for (const part of argv[i + 1].split(",")) {
        const t = part.trim();
        if (t && !out.includes(t)) out.push(t);
      }
      i += 1;
    }
  }
  return out;
}
