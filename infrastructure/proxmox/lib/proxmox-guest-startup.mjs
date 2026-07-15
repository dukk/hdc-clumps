import { stderr as errout } from "node:process";

import { getLxcConfig, getQemuConfig } from "./proxmox-guest-resources.mjs";
import { isProxmoxConfigObject } from "./proxmox-config.mjs";
import { pveFormBody, pveJsonRequest } from "./pve-http.mjs";

export const DEFAULT_STARTUP_UP_SECONDS = 30;

/**
 * @typedef {object} GuestStartupSpec
 * @property {number} order
 * @property {number} [up]
 * @property {number} [down]
 */

/**
 * @typedef {object} GuestBootOpts
 * @property {number} [onboot]
 * @property {GuestStartupSpec | null} [startup]
 */

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {number | undefined}
 */
function asPositiveInt(v) {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d+$/.test(v.trim())
        ? Number(v.trim())
        : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/**
 * @param {unknown} cfg
 */
export function defaultUpFromProxmoxConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return DEFAULT_STARTUP_UP_SECONDS;
  const provision = cfg.provision;
  if (!isObject(provision)) return DEFAULT_STARTUP_UP_SECONDS;
  const startup = provision.startup;
  if (!isObject(startup)) return DEFAULT_STARTUP_UP_SECONDS;
  const up = asPositiveInt(startup.default_up);
  return up !== undefined ? up : DEFAULT_STARTUP_UP_SECONDS;
}

/**
 * @param {unknown} cfg
 * @returns {Record<string, number>}
 */
export function startupPrioritiesFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return {};
  const provision = cfg.provision;
  if (!isObject(provision)) return {};
  const startup = provision.startup;
  if (!isObject(startup)) return {};
  const priorities = startup.priorities;
  if (!isObject(priorities)) return {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const [pkgId, order] of Object.entries(priorities)) {
    const n = asPositiveInt(order);
    if (pkgId.trim() && n !== undefined && n > 0) {
      out[pkgId.trim()] = n;
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {GuestStartupSpec | null}
 */
export function parseStartupObject(raw) {
  if (!isObject(raw)) return null;
  const order = asPositiveInt(raw.order);
  if (order === undefined || order <= 0) return null;
  /** @type {GuestStartupSpec} */
  const spec = { order };
  const up = asPositiveInt(raw.up);
  if (up !== undefined) spec.up = up;
  const down = asPositiveInt(raw.down);
  if (down !== undefined) spec.down = down;
  return spec;
}

/**
 * @param {GuestStartupSpec} spec
 */
export function formatProxmoxStartupString(spec) {
  /** @type {string[]} */
  const parts = [`order=${spec.order}`];
  if (spec.up !== undefined) parts.push(`up=${spec.up}`);
  if (spec.down !== undefined) parts.push(`down=${spec.down}`);
  return parts.join(",");
}

/**
 * @param {unknown} live
 * @returns {GuestStartupSpec | null}
 */
export function parseProxmoxStartupString(live) {
  if (typeof live !== "string" || !live.trim()) return null;
  /** @type {Partial<GuestStartupSpec>} */
  const spec = {};
  for (const part of live.split(",")) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (!key || value === undefined) continue;
    const n = asPositiveInt(value);
    if (n === undefined) continue;
    if (key === "order") spec.order = n;
    else if (key === "up") spec.up = n;
    else if (key === "down") spec.down = n;
  }
  if (spec.order === undefined || spec.order <= 0) return null;
  return /** @type {GuestStartupSpec} */ (spec);
}

/**
 * @param {GuestStartupSpec | null} a
 * @param {GuestStartupSpec | null} b
 */
export function startupSpecsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.order === b.order && (a.up ?? undefined) === (b.up ?? undefined) && (a.down ?? undefined) === (b.down ?? undefined);
}

/**
 * @param {unknown} block proxmox.lxc or proxmox.qemu
 * @param {unknown} [proxmoxCfg]
 * @param {string} [clumpId]
 * @returns {GuestBootOpts | null}
 */
export function parseGuestBootOptions(block, proxmoxCfg, clumpId) {
  if (!isObject(block)) return null;

  let onboot;
  if (block.onboot !== undefined) {
    onboot = Number(block.onboot) === 0 || block.onboot === false ? 0 : 1;
  }

  let startup = parseStartupObject(block.startup);
  if (!startup && clumpId && proxmoxCfg) {
    const priorities = startupPrioritiesFromConfig(proxmoxCfg);
    const order = priorities[clumpId];
    if (order !== undefined) {
      startup = { order, up: defaultUpFromProxmoxConfig(proxmoxCfg) };
    }
  }

  if (startup && startup.up === undefined && proxmoxCfg) {
    startup = { ...startup, up: defaultUpFromProxmoxConfig(proxmoxCfg) };
  }

  if (onboot === undefined && !startup) return null;

  return {
    onboot: onboot ?? 1,
    startup: startup ?? null,
  };
}

/**
 * @param {unknown} block
 * @param {unknown} [proxmoxCfg]
 * @param {string} [clumpId]
 */
export function guestBootOptsFromBlock(block, proxmoxCfg, clumpId) {
  return parseGuestBootOptions(block, proxmoxCfg, clumpId);
}

/**
 * @param {unknown} liveCfg
 */
function readLiveBootOptions(liveCfg) {
  const cfg = isObject(liveCfg) ? liveCfg : {};
  let onboot;
  if (cfg.onboot !== undefined) {
    onboot = Number(cfg.onboot) === 0 || cfg.onboot === false ? 0 : 1;
  }
  const startup = parseProxmoxStartupString(cfg.startup);
  return { onboot, startup };
}

/**
 * @param {object} opts
 * @param {"lxc"|"qemu"} opts.guestType
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {GuestBootOpts} opts.boot
 * @param {(line: string) => void} [opts.log]
 */
export async function applyGuestBootOptions(opts) {
  const { guestType, apiBase, authorization, rejectUnauthorized, node, vmid, boot } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));

  const statusOpts = { apiBase, authorization, rejectUnauthorized, node, vmid };
  const liveCfg =
    guestType === "lxc" ? await getLxcConfig(statusOpts) : await getQemuConfig(statusOpts);
  const live = readLiveBootOptions(liveCfg);

  const desiredOnboot = boot.onboot ?? 1;
  const desiredStartup = boot.startup ?? null;

  const onbootMatches = live.onboot === desiredOnboot;
  const startupMatches = startupSpecsEqual(live.startup, desiredStartup);

  if (onbootMatches && startupMatches) {
    log(
      `${guestType.toUpperCase()} ${vmid}: onboot=${desiredOnboot}${desiredStartup ? ` startup=${formatProxmoxStartupString(desiredStartup)}` : ""} already match — skipping.`,
    );
    return {
      ok: true,
      changed: false,
      applied: { onboot: desiredOnboot, startup: desiredStartup },
    };
  }

  /** @type {Record<string, string | number>} */
  const fields = { onboot: desiredOnboot };
  if (desiredStartup) {
    fields.startup = formatProxmoxStartupString(desiredStartup);
  }

  const configPath = `/nodes/${encodeURIComponent(node)}/${guestType}/${encodeURIComponent(String(vmid))}/config`;
  log(
    `${guestType.toUpperCase()} ${vmid}: setting onboot=${desiredOnboot}${desiredStartup ? ` startup=${fields.startup}` : ""} …`,
  );
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody(fields),
  );

  return {
    ok: true,
    changed: true,
    previous: live,
    applied: { onboot: desiredOnboot, startup: desiredStartup },
  };
}

/**
 * Apply boot options when block or package priority resolves them.
 * @param {object} opts
 * @param {"lxc"|"qemu"} opts.guestType
 * @param {unknown} [opts.block]
 * @param {unknown} [opts.proxmoxCfg]
 * @param {string} [opts.clumpId]
 */
export async function applyGuestBootOptionsFromBlock(opts) {
  const boot = parseGuestBootOptions(opts.block, opts.proxmoxCfg, opts.clumpId);
  if (!boot || (!boot.startup && boot.onboot === undefined)) {
    return { ok: true, skipped: true, message: "no boot options in block" };
  }
  if (!boot.startup) {
    return { ok: true, skipped: true, message: "no startup order configured" };
  }
  return applyGuestBootOptions({
    guestType: opts.guestType,
    apiBase: opts.apiBase,
    authorization: opts.authorization,
    rejectUnauthorized: opts.rejectUnauthorized,
    node: opts.node,
    vmid: opts.vmid,
    boot,
    log: opts.log,
  });
}
