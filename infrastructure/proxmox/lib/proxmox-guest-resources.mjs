import { stderr as errout } from "node:process";

import { extractPveUpid } from "./proxmox-qemu-post-clone.mjs";
import { getLxcRuntimeStatus, startLxc } from "./proxmox-lxc-start.mjs";
import { pveData, pveFormBody, pveJsonRequest, waitForPveTask } from "./pve-http.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { guestBootOptsFromBlock } from "./proxmox-guest-startup.mjs";

const QEMU_CPU_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * @typedef {object} GuestResourceSizing
 * @property {number} memoryMb
 * @property {number} cores
 */

/**
 * @typedef {import("./proxmox-guest-startup.mjs").GuestBootOpts} GuestBootOpts
 */

/**
 * @typedef {object} GuestResourceOpts
 * @property {number} memoryMb
 * @property {number} cores
 * @property {string} [cpu] QEMU CPU type (e.g. host). Applied on clone/maintain when set.
 * @property {boolean} [reboot]
 * @property {boolean} [rebootOnChange]
 * @property {GuestBootOpts} [boot]
 */

/**
 * @param {unknown} v
 * @returns {number | undefined}
 */
function asPositiveInt(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * @param {unknown} source config block with memory_mb / cores
 * @returns {GuestResourceSizing | null}
 */
export function parseGuestResourceSizing(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const o = /** @type {Record<string, unknown>} */ (source);
  const memoryMb = asPositiveInt(o.memory_mb);
  const cores = asPositiveInt(o.cores);
  if (memoryMb === undefined || cores === undefined) return null;
  return { memoryMb, cores };
}

/**
 * Optional QEMU CPU type from a proxmox.qemu block (`host`, `kvm64`, `x86-64-v2`, …).
 * @param {unknown} source
 * @returns {string | undefined}
 */
export function parseGuestCpuType(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const raw = /** @type {Record<string, unknown>} */ (source).cpu;
  if (typeof raw !== "string") return undefined;
  const cpu = raw.trim();
  if (!cpu || !QEMU_CPU_RE.test(cpu)) return undefined;
  return cpu;
}

/**
 * @param {unknown} raw live Proxmox `cpu` field
 * @returns {string}
 */
export function normalizeQemuCpuType(raw) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s || s === "kvm64") return "kvm64";
  return s;
}

/**
 * @param {Record<string, string>} [flags]
 * @returns {boolean}
 */
export function rebootRequestedFromFlags(flags) {
  return flags !== undefined && flagGet(flags, "reboot") !== undefined;
}

/**
 * @param {Record<string, string>} [flags]
 * @returns {boolean}
 */
export function noRebootFromFlags(flags) {
  return flags !== undefined && flagGet(flags, "no-reboot", "no_reboot") !== undefined;
}

/**
 * @param {Record<string, string>} [flags]
 * @param {boolean} [rebootOnChange]
 */
export function resolveRebootAfterResourceApply(flags, rebootOnChange = false) {
  if (noRebootFromFlags(flags)) return false;
  if (rebootRequestedFromFlags(flags)) return true;
  return rebootOnChange;
}

/**
 * @param {unknown} block proxmox.qemu or proxmox.lxc
 * @param {Record<string, string>} [flags]
 * @param {unknown} [proxmoxCfg]
 * @param {string} [clumpId]
 * @returns {GuestResourceOpts | undefined}
 */
export function guestResourceOptsFromBlock(block, flags, proxmoxCfg, clumpId) {
  const sizing = parseGuestResourceSizing(block);
  if (!sizing) return undefined;
  const boot = guestBootOptsFromBlock(block, proxmoxCfg, clumpId);
  const cpu = parseGuestCpuType(block);
  return {
    memoryMb: sizing.memoryMb,
    cores: sizing.cores,
    reboot: rebootRequestedFromFlags(flags),
    ...(boot?.startup ? { boot } : {}),
    ...(cpu ? { cpu } : {}),
  };
}

/**
 * @param {Record<string, unknown>} cfg
 */
function readConfigMemoryCores(cfg) {
  const memory = asPositiveInt(cfg.memory);
  const cores = asPositiveInt(cfg.cores);
  return { memory, cores };
}

/**
 * @param {object} opts
 */
async function getGuestConfig(opts, guestType) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const path = `/nodes/${encodeURIComponent(node)}/${guestType}/${encodeURIComponent(String(vmid))}/config`;
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    undefined,
  );
  const data = pveData(body);
  return data && typeof data === "object" && !Array.isArray(data)
    ? /** @type {Record<string, unknown>} */ (data)
    : {};
}

/**
 * @param {object} opts
 */
export async function getQemuConfig(opts) {
  return getGuestConfig(opts, "qemu");
}

/**
 * @param {object} opts
 */
export async function getLxcConfig(opts) {
  return getGuestConfig(opts, "lxc");
}

/**
 * @param {object} opts
 */
async function getQemuRuntimeStatus(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/status/current`;
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    undefined,
  );
  const data = pveData(body);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const status = /** @type {Record<string, unknown>} */ (data).status;
    if (typeof status === "string") return status.trim();
  }
  return "";
}

/**
 * POST .../status/stop and wait for task (LXC).
 * @param {object} opts
 */
async function stopLxc(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}/status/stop`;
  log(`Stopping LXC ${vmid} on ${node} …`);
  const body = await pveJsonRequest(
    "POST",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody({}),
  );
  const upid = extractPveUpid(pveData(body));
  if (upid) {
    await waitForPveTask({
      apiBase,
      node,
      upid,
      authorization,
      rejectUnauthorized,
      timeoutMs: 300_000,
      log,
    });
  }
  log(`LXC ${vmid} stop finished on ${node}.`);
}

/**
 * @param {object} opts
 * @param {"qemu"|"lxc"} guestType
 */
async function rebootGuest(opts, guestType) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/${guestType}/${encodeURIComponent(String(vmid))}/status/reboot`;
  log(`Rebooting ${guestType.toUpperCase()} ${vmid} on ${node} …`);
  const body = await pveJsonRequest(
    "POST",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody({}),
  );
  const upid = extractPveUpid(pveData(body));
  if (upid) {
    await waitForPveTask({
      apiBase,
      node,
      upid,
      authorization,
      rejectUnauthorized,
      timeoutMs: 300_000,
      log,
    });
  }
  log(`${guestType.toUpperCase()} ${vmid} reboot task finished on ${node}.`);
}

/**
 * @param {object} opts
 */
export async function rebootQemuGuest(opts) {
  return rebootGuest(opts, "qemu");
}

/**
 * @param {object} opts
 */
export async function rebootLxcGuest(opts) {
  return rebootGuest(opts, "lxc");
}

/**
 * POST .../status/stop and wait for task (QEMU). CPU type changes need a QEMU
 * process restart; ACPI reboot is not enough.
 * @param {object} opts
 */
async function stopQemuGuest(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/status/stop`;
  log(`Stopping QEMU ${vmid} on ${node} …`);
  const body = await pveJsonRequest(
    "POST",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody({}),
  );
  const upid = extractPveUpid(pveData(body));
  if (upid) {
    await waitForPveTask({
      apiBase,
      node,
      upid,
      authorization,
      rejectUnauthorized,
      timeoutMs: 300_000,
      log,
    });
  }
  log(`QEMU ${vmid} stop finished on ${node}.`);
}

/**
 * POST .../status/start and wait for task (QEMU).
 * @param {object} opts
 */
async function startQemuGuest(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/status/start`;
  log(`Starting QEMU ${vmid} on ${node} …`);
  const body = await pveJsonRequest(
    "POST",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody({}),
  );
  const upid = extractPveUpid(pveData(body));
  if (upid) {
    await waitForPveTask({
      apiBase,
      node,
      upid,
      authorization,
      rejectUnauthorized,
      timeoutMs: 300_000,
      log,
    });
  }
  log(`QEMU ${vmid} start finished on ${node}.`);
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {number} opts.memoryMb
 * @param {number} opts.cores
 * @param {string} [opts.cpu]
 * @param {boolean} [opts.reboot]
 * @param {boolean} [opts.rebootOnChange]
 * @param {(line: string) => void} [opts.log]
 */
export async function applyQemuGuestResources(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid, memoryMb, cores } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const statusOpts = { apiBase, authorization, rejectUnauthorized, node, vmid };
  const desiredCpu = typeof opts.cpu === "string" && opts.cpu.trim() ? opts.cpu.trim() : undefined;

  const beforeCfg = await getQemuConfig(statusOpts);
  const previous = readConfigMemoryCores(beforeCfg);
  const previousCpu = normalizeQemuCpuType(beforeCfg.cpu);
  const cpuChanged = Boolean(desiredCpu) && previousCpu !== normalizeQemuCpuType(desiredCpu);
  const needsChange = previous.memory !== memoryMb || previous.cores !== cores || cpuChanged;

  const applied = {
    memory: memoryMb,
    cores,
    ...(desiredCpu ? { cpu: desiredCpu } : {}),
  };
  const previousOut = {
    memory: previous.memory,
    cores: previous.cores,
    cpu: previousCpu,
  };

  if (!needsChange) {
    log(
      `QEMU ${vmid}: memory=${memoryMb} cores=${cores}${desiredCpu ? ` cpu=${desiredCpu}` : ""} already match config — skipping.`,
    );
    return {
      ok: true,
      changed: false,
      previous: previousOut,
      applied,
    };
  }

  const configPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;
  const putBody = { memory: memoryMb, cores, ...(desiredCpu ? { cpu: desiredCpu } : {}) };
  log(
    `QEMU ${vmid}: setting memory=${memoryMb} cores=${cores}${desiredCpu ? ` cpu=${desiredCpu}` : ""} (was memory=${previous.memory ?? "?"} cores=${previous.cores ?? "?"}${desiredCpu ? ` cpu=${previousCpu}` : ""}) …`,
  );
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody(putBody),
  );

  const status = await getQemuRuntimeStatus(statusOpts);
  const shouldRestart = Boolean(opts.reboot || opts.rebootOnChange);
  if (cpuChanged && status === "running") {
    if (shouldRestart) {
      log(`QEMU ${vmid}: CPU type changed — stop/start required (ACPI reboot keeps kvm64).`);
      await stopQemuGuest({ ...statusOpts, log });
      await startQemuGuest({ ...statusOpts, log });
    } else {
      log(`QEMU ${vmid}: CPU type written; QEMU restart skipped (--no-reboot). New CPU applies on next start.`);
    }
  } else if (shouldRestart && status === "running") {
    await rebootQemuGuest({ ...statusOpts, log });
  } else if (shouldRestart && status !== "running") {
    log(`QEMU ${vmid}: reboot skipped (guest status: ${status || "stopped"}).`);
  } else if (status === "running") {
    log(`QEMU ${vmid}: running — guest OS may need a reboot for RAM changes to take effect.`);
  }

  return {
    ok: true,
    changed: true,
    previous: previousOut,
    applied,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {number} opts.memoryMb
 * @param {number} opts.cores
 * @param {boolean} [opts.reboot]
 * @param {boolean} [opts.rebootOnChange]
 * @param {(line: string) => void} [opts.log]
 */
export async function applyLxcGuestResources(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid, memoryMb, cores } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const statusOpts = { apiBase, authorization, rejectUnauthorized, node, vmid };

  const beforeCfg = await getLxcConfig(statusOpts);
  const previous = readConfigMemoryCores(beforeCfg);
  const needsChange = previous.memory !== memoryMb || previous.cores !== cores;

  if (!needsChange) {
    log(`LXC ${vmid}: memory=${memoryMb} cores=${cores} already match config — skipping.`);
    return {
      ok: true,
      changed: false,
      previous: { memory: previous.memory, cores: previous.cores },
      applied: { memory: memoryMb, cores },
    };
  }

  const wasRunning = (await getLxcRuntimeStatus(statusOpts)) === "running";
  if (wasRunning) {
    await stopLxc({ ...statusOpts, log });
  }

  const configPath = `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}/config`;
  log(
    `LXC ${vmid}: setting memory=${memoryMb} cores=${cores} (was memory=${previous.memory ?? "?"} cores=${previous.cores ?? "?"}) …`,
  );
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({ memory: memoryMb, cores }),
  );

  if (wasRunning) {
    try {
      await startLxc({ ...statusOpts, log });
    } catch (e) {
      const afterStart = await getLxcRuntimeStatus(statusOpts);
      if (afterStart !== "running") throw e;
      log(
        `LXC ${vmid} start after resize reported ${/** @type {Error} */ (e).message} but container is running — continuing.`,
      );
    }
    if (opts.reboot || opts.rebootOnChange) {
      log(`LXC ${vmid}: restarted after resize (stop/start).`);
    }
  } else {
    const status = await getLxcRuntimeStatus(statusOpts);
    const shouldReboot = Boolean(opts.reboot || opts.rebootOnChange);
    if (shouldReboot && status === "running") {
      await rebootLxcGuest({ ...statusOpts, log });
    } else if (shouldReboot) {
      log(`LXC ${vmid}: reboot skipped (container not running).`);
    }
  }

  return {
    ok: true,
    changed: true,
    previous: { memory: previous.memory, cores: previous.cores },
    applied: { memory: memoryMb, cores },
  };
}
