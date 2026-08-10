/**
 * Import live Paper whitelist.json / ops.json into hdc-private minecraft config.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { HDC_INCLUDE_KEY } from "hdc/cli/lib/json-config-preprocess.mjs";
import { formatRepoJson, writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} item
 */
function isIncludeDirective(item) {
  return isObject(item) && HDC_INCLUDE_KEY in item && Object.keys(item).length === 1;
}

/**
 * @param {string} uuid
 */
function normUuid(uuid) {
  return String(uuid || "")
    .trim()
    .toLowerCase();
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>[]}
 */
export function parseLiveWhitelistPlayers(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const row of raw) {
    if (!isObject(row)) continue;
    const uuid = String(row.uuid || "").trim();
    const name = String(row.name || "").trim();
    if (!UUID_RE.test(uuid) || !name) continue;
    /** @type {Record<string, unknown>} */
    const entry = { uuid, name };
    const edition = typeof row.edition === "string" ? row.edition.trim().toLowerCase() : "";
    if (edition === "bedrock") entry.edition = "bedrock";
    if (row.xuid != null && String(row.xuid).trim()) entry.xuid = String(row.xuid).trim();
    // Live Paper whitelist uses Floodgate-prefixed names for Bedrock (.Gamertag).
    if (name.startsWith(".") && !entry.edition) {
      entry.edition = "bedrock";
      entry.name = name.slice(1);
    }
    out.push(entry);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ uuid: string, name: string, level: number, bypassesPlayerLimit: boolean }[]}
 */
export function parseLiveOps(raw) {
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
 * Union by uuid: live wins on conflict; config-only entries are kept.
 * @template {Record<string, unknown>} T
 * @param {T[]} live
 * @param {T[]} config
 * @returns {T[]}
 */
export function mergePlayersByUuid(live, config) {
  /** @type {Map<string, T>} */
  const map = new Map();
  for (const row of config) {
    const id = normUuid(row.uuid);
    if (id) map.set(id, row);
  }
  for (const row of live) {
    const id = normUuid(row.uuid);
    if (id) map.set(id, row);
  }
  return [...map.values()];
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").resolveMinecraftDeployments>[number]} deployment
 * @param {string} installDir
 * @returns {{ whitelist: unknown, ops: unknown }}
 */
export function fetchLiveWhitelistAndOps(deployment, installDir = "/opt/minecraft") {
  const configure = isObject(deployment.configure) ? deployment.configure : {};
  const sshCfg = isObject(configure.ssh) ? configure.ssh : {};
  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim()
      ? sshCfg.host.trim()
      : ip.split("/")[0];
  if (!sshHost) {
    throw new Error(`${deployment.systemId}: configure.ssh.host or proxmox.qemu.ip required for import`);
  }
  const sshUser = resolveGuestSshUser(sshCfg.user);
  const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
  const dir = String(installDir || "/opt/minecraft").replace(/\/+$/, "") || "/opt/minecraft";
  const wl = exec.run(`cat ${JSON.stringify(`${dir}/whitelist.json`)} 2>/dev/null || echo '[]'`, {
    capture: true,
  });
  if (wl.status !== 0) {
    throw new Error(`read whitelist.json failed: ${(wl.stderr || wl.stdout || "").trim()}`);
  }
  const ops = exec.run(`cat ${JSON.stringify(`${dir}/ops.json`)} 2>/dev/null || echo '[]'`, {
    capture: true,
  });
  if (ops.status !== 0) {
    throw new Error(`read ops.json failed: ${(ops.stderr || ops.stdout || "").trim()}`);
  }
  let whitelistRaw;
  let opsRaw;
  try {
    whitelistRaw = JSON.parse((wl.stdout || "").trim() || "[]");
  } catch (e) {
    throw new Error(`invalid live whitelist.json: ${/** @type {Error} */ (e).message}`);
  }
  try {
    opsRaw = JSON.parse((ops.stdout || "").trim() || "[]");
  } catch (e) {
    throw new Error(`invalid live ops.json: ${/** @type {Error} */ (e).message}`);
  }
  return { whitelist: whitelistRaw, ops: opsRaw };
}

/**
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 * @returns {{ path: string, rel: string } | null}
 */
export function resolveWhitelistSidecar(resolved) {
  if (!resolved?.found || !existsSync(resolved.path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolved.path, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(raw) || !isObject(raw.minecraft)) return null;
  const wl = raw.minecraft.whitelist;
  if (!isObject(wl) || !Array.isArray(wl.players)) return null;
  const include = wl.players.find(isIncludeDirective);
  if (!include) return null;
  const file = include[HDC_INCLUDE_KEY];
  const rel =
    typeof file === "string"
      ? file.trim()
      : isObject(file) && typeof file.file === "string"
        ? file.file.trim()
        : "";
  if (!rel || rel.includes("..")) return null;
  const path = join(dirname(resolved.path), rel);
  return { path, rel };
}

/**
 * @param {object} opts
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} opts.resolved
 * @param {Record<string, unknown>} opts.cfg preprocessed (includes expanded) or disk root — we rewrite disk root
 * @param {Record<string, unknown>[]} opts.whitelistPlayers
 * @param {{ uuid: string, name: string, level: number, bypassesPlayerLimit: boolean }[]} opts.ops
 * @param {(line: string) => void} [opts.log]
 */
export function writeImportedMinecraftLists(opts) {
  const { resolved, whitelistPlayers, ops, log = () => {} } = opts;
  if (!resolved.found) {
    throw new Error("minecraft config missing — cannot import lists");
  }
  const diskRoot = /** @type {Record<string, unknown>} */ (
    JSON.parse(readFileSync(resolved.path, "utf8"))
  );
  if (!isObject(diskRoot.minecraft)) {
    diskRoot.minecraft = {};
  }
  const mc = /** @type {Record<string, unknown>} */ (diskRoot.minecraft);

  const sidecar = resolveWhitelistSidecar(resolved);
  if (sidecar) {
    mkdirSync(dirname(sidecar.path), { recursive: true });
    writeFileSync(sidecar.path, formatRepoJson(whitelistPlayers), "utf8");
    log(`wrote ${whitelistPlayers.length} whitelist players → ${sidecar.rel}`);
    if (!isObject(mc.whitelist)) {
      mc.whitelist = { enabled: true, enforce: true, players: [{ [HDC_INCLUDE_KEY]: sidecar.rel }] };
    }
  } else {
    if (!isObject(mc.whitelist)) {
      mc.whitelist = { enabled: true, enforce: true };
    }
    /** @type {Record<string, unknown>} */ (mc.whitelist).players = whitelistPlayers;
    log(`wrote ${whitelistPlayers.length} whitelist players inline in config.json`);
  }

  mc.ops = ops;
  writeResolvedRepoJson(resolved, diskRoot);
  log(`wrote ${ops.length} ops → config.json`);
  return {
    ok: true,
    whitelist_count: whitelistPlayers.length,
    ops_count: ops.length,
    whitelist_sidecar: sidecar?.rel ?? null,
    path: resolved.path,
  };
}

/**
 * Pull live lists, merge with current config (live wins; config-only kept), write hdc-private.
 *
 * @param {object} opts
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} opts.resolved
 * @param {Record<string, unknown>} opts.cfg loaded/preprocessed config
 * @param {ReturnType<typeof import("./deployments.mjs").resolveMinecraftDeployments>[number]} opts.deployment
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.mergeWithConfig] default true
 */
export function importMinecraftListsFromLive(opts) {
  const { resolved, cfg, deployment, log = () => {}, mergeWithConfig = true } = opts;
  const installDir =
    isObject(cfg.minecraft) && typeof cfg.minecraft.install_dir === "string"
      ? cfg.minecraft.install_dir
      : "/opt/minecraft";
  log(`importing whitelist/ops from ${deployment.systemId} …`);
  const live = fetchLiveWhitelistAndOps(deployment, installDir);
  let whitelistPlayers = parseLiveWhitelistPlayers(live.whitelist);
  let ops = parseLiveOps(live.ops);

  if (mergeWithConfig && isObject(cfg.minecraft)) {
    const mc = cfg.minecraft;
    const cfgWl = isObject(mc.whitelist) && Array.isArray(mc.whitelist.players) ? mc.whitelist.players : [];
    const cfgOps = Array.isArray(mc.ops) ? mc.ops : [];
    whitelistPlayers = mergePlayersByUuid(
      whitelistPlayers,
      parseLiveWhitelistPlayers(cfgWl),
    );
    ops = mergePlayersByUuid(ops, parseLiveOps(cfgOps));
  }

  return writeImportedMinecraftLists({
    resolved,
    cfg,
    whitelistPlayers,
    ops,
    log,
  });
}
