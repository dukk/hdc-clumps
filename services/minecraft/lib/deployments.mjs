import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const MINECRAFT_ROLE = "minecraft";
const MINECRAFT_QEMU_SYSTEM_ID = /^vm-minecraft-[a-z]+$/;

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
 * @param {Record<string, unknown>} deployment
 */
export function mergeMinecraftSettings(cfg, deployment) {
  const global = isObject(cfg.minecraft) ? structuredClone(cfg.minecraft) : {};
  const local = isObject(deployment.minecraft) ? deployment.minecraft : {};
  deepMerge(global, local);
  const paper = isObject(global.paper) ? global.paper : {};
  const version =
    typeof paper.version === "string" && paper.version.trim() ? paper.version.trim() : "latest";
  const heap =
    typeof global.java_heap === "string" && global.java_heap.trim() ? global.java_heap.trim() : "5G";
  const heapMin =
    typeof global.java_heap_min === "string" && global.java_heap_min.trim()
      ? global.java_heap_min.trim()
      : "2G";
  const javaJvmArgs =
    typeof global.java_jvm_args === "string" && global.java_jvm_args.trim()
      ? global.java_jvm_args.trim()
      : "";
  const installDir =
    typeof global.install_dir === "string" && global.install_dir.trim()
      ? global.install_dir.trim()
      : "/opt/minecraft";
  const javaPort =
    typeof global.java_port === "number" && Number.isFinite(global.java_port)
      ? Math.trunc(global.java_port)
      : Number(global.java_port) || 25565;
  const bedrockPort =
    typeof global.bedrock_port === "number" && Number.isFinite(global.bedrock_port)
      ? Math.trunc(global.bedrock_port)
      : Number(global.bedrock_port) || 19132;
  const motd =
    typeof global.motd === "string" && global.motd.trim() ? global.motd.trim() : "HDC Minecraft";
  const maxPlayers =
    typeof global.max_players === "number" && Number.isFinite(global.max_players)
      ? Math.trunc(global.max_players)
      : Number(global.max_players) || 20;
  const bluemap = parseBluemap(global.bluemap);
  const worldguard = global.worldguard === true;
  return {
    paperVersion: version,
    paperExtras: parsePaperExtras(paper),
    eula: global.eula !== false,
    javaHeapMin: heapMin,
    javaHeap: heap,
    javaJvmArgs,
    installDir,
    javaPort,
    bedrockPort,
    motd,
    maxPlayers,
    onlineMode: global.online_mode !== false,
    geyser: global.geyser !== false,
    floodgate: global.floodgate !== false,
    bluemap: bluemap.enabled,
    bluemapWebPort: bluemap.webPort,
    essentialsx: global.essentialsx === true,
    essentialsxChat: global.essentialsx_chat === true,
    essentialsxSpawn: global.essentialsx_spawn === true,
    worldedit: global.worldedit === true || worldguard,
    worldguard,
    vault: global.vault === true,
    treeFeller: global.tree_feller === true,
    chunky: global.chunky === true,
    deadChest: global.dead_chest === true,
    decentHolograms: global.decent_holograms === true,
    dropHeads: global.drop_heads === true,
    luckperms: global.luckperms === true,
    protocollib: global.protocollib === true,
    requests: global.requests === true,
    signshop: global.signshop === true,
    silkSpawners: global.silk_spawners === true,
    vanishNoPacket: global.vanish_no_packet === true,
    worldeditSui: global.worldedit_sui === true,
    serverProperties: parseServerProperties(global.server_properties),
    whitelist: parseWhitelist(global.whitelist),
    ops: parseOps(global.ops),
    floodgateUsernamePrefix:
      typeof global.floodgate_username_prefix === "string" ? global.floodgate_username_prefix : ".",
    stopWarning: parseStopWarning(global.stop_warning),
    backup: parseBackup(global.backup),
  };
}

const DEFAULT_STOP_WARNING_MESSAGE = "Server shutting down in 10 seconds…";

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, seconds: number, message: string }}
 */
function parseStopWarning(raw) {
  const defaults = {
    enabled: true,
    seconds: 10,
    message: DEFAULT_STOP_WARNING_MESSAGE,
  };
  if (raw === false) return { ...defaults, enabled: false };
  if (!isObject(raw)) return defaults;
  const secondsRaw = Number(raw.seconds);
  const seconds = Number.isFinite(secondsRaw) ? Math.max(0, Math.trunc(secondsRaw)) : defaults.seconds;
  const message =
    typeof raw.message === "string" && raw.message.trim()
      ? raw.message.trim().replace(/\r?\n/g, " ")
      : defaults.message;
  return {
    enabled: raw.enabled !== false,
    seconds,
    message,
  };
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, intervalHours: number, retainDaily: number }}
 */
function parseBackup(raw) {
  const defaults = { enabled: true, intervalHours: 6, retainDaily: 7 };
  if (raw === false) return { ...defaults, enabled: false };
  if (!isObject(raw)) return defaults;
  const intervalRaw = Number(raw.interval_hours ?? raw.intervalHours);
  const retainRaw = Number(raw.retain_daily ?? raw.retainDaily);
  const intervalHours = Number.isFinite(intervalRaw)
    ? Math.min(24, Math.max(1, Math.trunc(intervalRaw)))
    : defaults.intervalHours;
  const retainDaily = Number.isFinite(retainRaw)
    ? Math.min(90, Math.max(1, Math.trunc(retainRaw)))
    : defaults.retainDaily;
  return {
    enabled: raw.enabled !== false,
    intervalHours,
    retainDaily,
  };
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, webPort: number }}
 */
function parseBluemap(raw) {
  if (raw === true) return { enabled: true, webPort: 8100 };
  if (raw === false || raw == null) return { enabled: false, webPort: 8100 };
  if (!isObject(raw)) return { enabled: false, webPort: 8100 };
  const webPort =
    typeof raw.web_port === "number" && Number.isFinite(raw.web_port)
      ? Math.trunc(raw.web_port)
      : Number(raw.web_port) || 8100;
  return { enabled: raw.enabled !== false, webPort };
}

const SERVER_PROP_KEY_RE = /^[a-z0-9._-]+$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} raw
 * @returns {Record<string, string | number | boolean>}
 */
function parseServerProperties(raw) {
  if (!isObject(raw)) return {};
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!SERVER_PROP_KEY_RE.test(key)) continue;
    if (typeof val === "boolean" || typeof val === "number" || typeof val === "string") {
      out[key] = val;
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, enforce: boolean, players: { uuid: string, name: string, edition: "java" | "bedrock", xuid?: string }[] } | null}
 */
function parseWhitelist(raw) {
  if (raw === undefined) return null;
  if (raw === false) return { enabled: false, enforce: false, players: [] };
  if (raw === true) return { enabled: true, enforce: true, players: [] };
  if (!isObject(raw)) return null;
  const players = Array.isArray(raw.players)
    ? raw.players
        .filter(isObject)
        .map((p) => {
          const name = String(p.name || "").trim();
          const uuid = String(p.uuid || "").trim();
          const xuid = String(p.xuid || "").trim();
          const editionRaw = String(p.edition || "").trim().toLowerCase();
          const edition = editionRaw === "bedrock" || editionRaw === "be" ? "bedrock" : "java";
          if (!name) return null;
          if (edition === "java" && !UUID_RE.test(uuid)) return null;
          if (edition === "bedrock" && uuid && !UUID_RE.test(uuid)) return null;
          /** @type {{ uuid: string, name: string, edition: "java" | "bedrock", xuid?: string }} */
          const row = { uuid, name, edition };
          if (xuid) row.xuid = xuid;
          return row;
        })
        .filter((p) => p != null)
    : [];
  return {
    enabled: raw.enabled !== false,
    enforce: raw.enforce !== false,
    players,
  };
}

/**
 * @param {unknown} raw
 * @returns {{ uuid: string, name: string, level: number, bypassesPlayerLimit: boolean }[] | null}
 */
function parseOps(raw) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isObject)
    .map((o) => ({
      uuid: String(o.uuid || "").trim(),
      name: String(o.name || "").trim(),
      level: Number.isFinite(Number(o.level)) ? Math.trunc(Number(o.level)) : 4,
      bypassesPlayerLimit: o.bypassesPlayerLimit === true,
    }))
    .filter((o) => UUID_RE.test(o.uuid) && o.name);
}

/**
 * @param {Record<string, unknown>} paper
 */
function parsePaperExtras(paper) {
  const rangeRaw = paper.keep_spawn_loaded_range;
  const range = Number.isFinite(Number(rangeRaw)) ? Math.trunc(Number(rangeRaw)) : null;
  return {
    perPlayerMobSpawns:
      paper.per_player_mob_spawns === true
        ? true
        : paper.per_player_mob_spawns === false
          ? false
          : null,
    keepSpawnLoadedRange: range && range > 0 ? range : null,
    antiXray:
      paper.anti_xray === true ? true : paper.anti_xray === false ? false : null,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeMinecraftConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("minecraft config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("minecraft config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  if (!raw.length) {
    throw new Error("deployments[] is empty — add at least one entry");
  }
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
    if (mode !== "proxmox-qemu") {
      throw new Error(`${sid}: only proxmox-qemu mode is supported (got ${JSON.stringify(mode)})`);
    }
    if (!MINECRAFT_QEMU_SYSTEM_ID.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-minecraft-<letter> for proxmox-qemu`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) {
      throw new Error(`${sid}: proxmox.host_id required`);
    }
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error(`${sid}: proxmox.qemu.vmid must be a positive number`);
    }
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    if (!ip) {
      throw new Error(`${sid}: proxmox.qemu.ip required (static CIDR for cloud-init)`);
    }
    const templateVmid = typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid);
    if (!Number.isFinite(templateVmid) || templateVmid <= 0) {
      throw new Error(`${sid}: proxmox.qemu.template_vmid must be a positive number`);
    }
  }
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listMinecraftDeploymentSummaries(cfg) {
  const { deployments } = normalizeMinecraftConfig(cfg);
  return deployments.map((d) => {
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    const install = isObject(d.install) ? d.install : {};
    const mc = mergeMinecraftSettings(cfg, d);
    return {
      system_id: d.system_id,
      mode: typeof d.mode === "string" ? d.mode : "proxmox-qemu",
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      ip: typeof q.ip === "string" ? q.ip : null,
      install_enabled: install.enabled !== false,
      paper_version: mc.paperVersion,
      java_port: mc.javaPort,
      bedrock_port: mc.bedrockPort,
      geyser: mc.geyser,
      floodgate: mc.floodgate,
      bluemap: mc.bluemap,
      bluemap_web_port: mc.bluemapWebPort,
      essentialsx: mc.essentialsx,
      worldedit: mc.worldedit,
      worldguard: mc.worldguard,
      vault: mc.vault,
      tree_feller: mc.treeFeller,
      chunky: mc.chunky,
      dead_chest: mc.deadChest,
      decent_holograms: mc.decentHolograms,
      drop_heads: mc.dropHeads,
      luckperms: mc.luckperms,
      protocollib: mc.protocollib,
      requests: mc.requests,
      signshop: mc.signshop,
      silk_spawners: mc.silkSpawners,
      vanish_no_packet: mc.vanishNoPacket,
      worldedit_sui: mc.worldeditSui,
      whitelist_enabled: mc.whitelist?.enabled ?? null,
      ops_count: Array.isArray(mc.ops) ? mc.ops.length : null,
    };
  });
}

/**
 * @param {string | undefined} instance
 * @param {Record<string, unknown>[] | undefined} [deployments]
 */
export function instanceFlagToSystemId(instance, deployments) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (MINECRAFT_QEMU_SYSTEM_ID.test(t)) return t;
  if (Array.isArray(deployments) && deployments.length > 0) {
    const letter = t.length === 1 || /^[a-z]+$/.test(t) ? t : null;
    if (letter) {
      const hit = deployments.find(
        (d) =>
          typeof d.system_id === "string" &&
          MINECRAFT_QEMU_SYSTEM_ID.test(d.system_id) &&
          d.system_id.endsWith(`-${letter}`),
      );
      if (hit && typeof hit.system_id === "string") return hit.system_id;
    }
  }
  return vmSystemId(MINECRAFT_ROLE, t);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveMinecraftDeployments(cfg, flags, opts = {}) {
  const { deployments } = normalizeMinecraftConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance, deployments);
  }

  if (deployments.length === 1) {
    const d = deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [finalizeDeployment(cfg, d, skipInstallCli, opts.skipInstall)];
  }

  if (!selectedId) {
    return deployments.map((d) => finalizeDeployment(cfg, d, skipInstallCli, opts.skipInstall));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) {
    throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [finalizeDeployment(cfg, d, skipInstallCli, opts.skipInstall)];
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 */
function finalizeDeployment(cfg, d, skipInstallCli, skipInstallOpt) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true, linux_user: "minecraft" };
  if (skipInstallCli || skipInstallOpt === true) {
    install.enabled = false;
  }
  if (typeof install.linux_user !== "string" || !install.linux_user.trim()) {
    install.linux_user = "minecraft";
  }
  return {
    systemId: String(d.system_id),
    mode: typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu",
    hostname:
      typeof d.hostname === "string" && d.hostname.trim() ? d.hostname.trim() : undefined,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    install,
    minecraft: mergeMinecraftSettings(cfg, d),
    raw: d,
  };
}
