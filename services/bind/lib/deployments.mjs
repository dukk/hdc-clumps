import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const BIND_ROLE = "bind";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
function deepMerge(target, source) {
  for (const [key, val] of Object.entries(source)) {
    if (isObject(val) && isObject(target[key])) {
      deepMerge(/** @type {Record<string, unknown>} */ (target[key]), val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

/**
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown>} entry
 */
function mergeDeploymentEntry(defaults, entry) {
  const base = structuredClone(defaults);
  deepMerge(base, entry);
  const systemId =
    typeof entry.system_id === "string" && entry.system_id.trim()
      ? entry.system_id.trim()
      : typeof base.system_id === "string" && base.system_id.trim()
        ? base.system_id.trim()
        : "";
  if (systemId) base.system_id = systemId;
  return base;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeBindConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("bind config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("bind config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const rawZones = Array.isArray(cfg.zones)
    ? cfg.zones
    : Array.isArray(defaults.zones)
      ? defaults.zones
      : [];
  const zones = parseBindZones(rawZones);
  const bind = isObject(cfg.bind) ? cfg.bind : isObject(defaults.bind) ? defaults.bind : {};
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments, zones, bind };
}

/**
 * @param {unknown[]} rawZones
 * @returns {BindZoneDefinition[]}
 */
export function parseBindZones(rawZones) {
  if (!rawZones.length) {
    throw new Error("bind config needs zones[] at top level or in defaults");
  }
  /** @type {BindZoneDefinition[]} */
  const zones = [];
  const ids = new Set();
  for (const entry of rawZones) {
    if (typeof entry === "string") {
      throw new Error(
        `zones[] must be objects with id and zone_type (string zone name ${JSON.stringify(entry)} is no longer supported)`,
      );
    }
    if (!isObject(entry)) {
      throw new Error("each zones[] entry must be an object");
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) throw new Error("each zone needs id (apex zone name)");
    if (ids.has(id)) throw new Error(`duplicate zone id ${JSON.stringify(id)}`);
    ids.add(id);
    const zoneType = typeof entry.zone_type === "string" ? entry.zone_type.trim().toLowerCase() : "";
    if (zoneType !== "forward" && zoneType !== "reverse") {
      throw new Error(`zone ${JSON.stringify(id)}: zone_type must be forward or reverse`);
    }
    if (zoneType === "reverse") {
      const subnet = typeof entry.subnet === "string" ? entry.subnet.trim() : "";
      if (!subnet) {
        throw new Error(`zone ${JSON.stringify(id)}: reverse zones need subnet (CIDR)`);
      }
    }
    const records = Array.isArray(entry.records) ? entry.records.filter(isObject) : [];
    zones.push({
      id,
      zone_type: /** @type {"forward" | "reverse"} */ (zoneType),
      subnet: typeof entry.subnet === "string" ? entry.subnet.trim() : undefined,
      records,
      ...(isObject(entry.cloudflare_fallback) ? { cloudflare_fallback: entry.cloudflare_fallback } : {}),
    });
  }
  return zones;
}

/**
 * @typedef {object} BindZoneDefinition
 * @property {string} id
 * @property {"forward" | "reverse"} zone_type
 * @property {string} [subnet]
 * @property {Record<string, unknown>[]} records
 * @property {Record<string, unknown>} [cloudflare_fallback]
 */

/**
 * @param {BindZoneDefinition[]} zones
 * @returns {Record<string, Record<string, unknown>>}
 */
export function zoneDefinitionsToMap(zones) {
  /** @type {Record<string, Record<string, unknown>>} */
  const map = {};
  for (const z of zones) {
    map[z.id] = {
      id: z.id,
      zone_type: z.zone_type,
      ...(z.subnet ? { subnet: z.subnet } : {}),
      records: z.records,
      ...(z.cloudflare_fallback ? { cloudflare_fallback: z.cloudflare_fallback } : {}),
    };
  }
  return map;
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  let primaryCount = 0;
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!/^vm-bind-[a-z]+$/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-bind-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const role = typeof d.role === "string" ? d.role.trim().toLowerCase() : "";
    if (role !== "primary" && role !== "secondary") {
      throw new Error(`${sid}: role must be primary or secondary`);
    }
    if (role === "primary") primaryCount += 1;
    const mode = typeof d.mode === "string" ? d.mode.trim() : "";
    if (mode === "proxmox-qemu" || mode === "configure-only") {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      if (mode === "proxmox-qemu") {
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        if (!hostId) throw new Error(`${sid}: proxmox.host_id required for proxmox-qemu`);
        const q = isObject(px.qemu) ? px.qemu : {};
        const ip = typeof q.ip === "string" ? q.ip.trim() : "";
        if (!ip) {
          throw new Error(`${sid}: proxmox.qemu.ip required for proxmox-qemu (static CIDR, e.g. 192.0.2.2/24)`);
        }
      }
    }
  }
  if (primaryCount !== 1) {
    throw new Error(`deployments must include exactly one primary (found ${primaryCount})`);
  }
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (/^vm-bind-[a-z]+$/.test(t)) return t;
  return vmSystemId(BIND_ROLE, t);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveBindDeployments(cfg, flags) {
  const { deployments } = normalizeBindConfig(cfg);
  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance);
  }

  if (deployments.length === 1) {
    const d = deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [finalizeDeployment(d)];
  }

  if (!selectedId) {
    const sorted = [...deployments].sort((a, b) => {
      const ra = typeof a.role === "string" && a.role === "primary" ? 0 : 1;
      const rb = typeof b.role === "string" && b.role === "primary" ? 0 : 1;
      return ra - rb;
    });
    return sorted.map((d) => finalizeDeployment(d));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [finalizeDeployment(d)];
}

/**
 * @param {Record<string, unknown>} d
 */
function finalizeDeployment(d) {
  const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
  const role = typeof d.role === "string" ? d.role.trim().toLowerCase() : "secondary";
  return {
    systemId: String(d.system_id),
    mode,
    role: /** @type {"primary" | "secondary"} */ (role),
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
  };
}

const DEFAULT_FORWARD_UPSTREAM = {
  mode: "plain",
  server: "odoh-cloudflare",
  relay: "odohrelay-crypto-sx",
  listen: "127.0.0.1:5300",
};

/**
 * @param {string} listen e.g. 127.0.0.1:5300
 */
export function bindForwarderFromListen(listen) {
  const trimmed = listen.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon <= 0) {
    throw new Error(`bind.forward_upstream.listen must be host:port (got ${JSON.stringify(listen)})`);
  }
  const host = trimmed.slice(0, lastColon);
  const port = trimmed.slice(lastColon + 1);
  if (!/^\d+$/.test(port)) {
    throw new Error(`bind.forward_upstream.listen port must be numeric (got ${JSON.stringify(listen)})`);
  }
  return `${host} port ${port}`;
}

/**
 * @param {Record<string, unknown>} bindBlock
 */
export function resolveForwardUpstream(bindBlock) {
  const fu = isObject(bindBlock.forward_upstream) ? bindBlock.forward_upstream : {};
  const modeRaw = typeof fu.mode === "string" ? fu.mode.trim().toLowerCase() : "plain";
  const mode = modeRaw === "odoh" ? "odoh" : "plain";
  const server =
    typeof fu.server === "string" && fu.server.trim()
      ? fu.server.trim()
      : DEFAULT_FORWARD_UPSTREAM.server;
  const relay =
    typeof fu.relay === "string" && fu.relay.trim() ? fu.relay.trim() : DEFAULT_FORWARD_UPSTREAM.relay;
  const listen =
    typeof fu.listen === "string" && fu.listen.trim()
      ? fu.listen.trim()
      : DEFAULT_FORWARD_UPSTREAM.listen;
  return { mode, server, relay, listen };
}

/**
 * @param {Record<string, unknown>} bindBlock
 * @param {boolean} recursion
 */
export function resolveBindForwarders(bindBlock, recursion) {
  const forwardUpstream = resolveForwardUpstream(bindBlock);
  if (forwardUpstream.mode === "odoh") {
    if (!recursion) {
      throw new Error("bind.forward_upstream.mode odoh requires bind.recursion true");
    }
    return {
      forwardUpstream,
      forwarders: [bindForwarderFromListen(forwardUpstream.listen)],
    };
  }
  const forwarders = Array.isArray(bindBlock.forwarders)
    ? bindBlock.forwarders.map((f) => String(f).trim()).filter(Boolean)
    : ["1.1.1.1", "1.0.0.1"];
  return { forwardUpstream, forwarders };
}

/**
 * Global bind + zone settings from normalized config.
 * @param {ReturnType<typeof normalizeBindConfig>} normalized
 */
export function bindGlobalSettings(normalized) {
  const b = isObject(normalized.bind) ? normalized.bind : {};
  const zoneDefinitions = zoneDefinitionsToMap(normalized.zones);
  const recursion = b.recursion !== false;
  const { forwardUpstream, forwarders } = resolveBindForwarders(b, recursion);
  return {
    zoneIds: normalized.zones.map((z) => z.id),
    zoneDefinitions,
    allowQueryCidrs: Array.isArray(b.allow_query_cidrs)
      ? b.allow_query_cidrs.map((c) => String(c).trim()).filter(Boolean)
      : ["192.0.2.0/24", "198.51.100.0/24", "127.0.0.0/8"],
    recursion,
    dnssecValidation: b.dnssec_validation !== false,
    tsigVaultKey:
      typeof b.tsig_vault_key === "string" && b.tsig_vault_key.trim()
        ? b.tsig_vault_key.trim()
        : "HDC_BIND_TSIG_KEY",
    hostmaster:
      typeof b.hostmaster === "string" && b.hostmaster.trim()
        ? b.hostmaster.trim()
        : "hostmaster.hdc.example.invalid",
    primaryIp: typeof b.primary_ip === "string" ? b.primary_ip.trim() : "192.0.2.2",
    secondaryIp: typeof b.secondary_ip === "string" ? b.secondary_ip.trim() : "192.0.2.3",
    forwardUpstream,
    forwarders,
  };
}
