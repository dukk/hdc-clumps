/**
 * Import / apply Minecraft plugin config trees as JSON text sidecars in hdc-private.
 *
 * Guest `$install_dir/plugins/<rel>` ↔ local `plugin-configs/<rel>.json`
 * Wrapper shape: `{ "guest_rel": "plugins/…", "content": "…" }`
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { formatRepoJson } from "hdc/cli/lib/private-repo.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { resolveLinuxUser } from "./minecraft-install.mjs";

export const PLUGIN_CONFIG_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PLUGIN_CONFIGS_DIR = "plugin-configs";

/** @type {Set<string>} */
export const CONFIG_LIKE_EXTENSIONS = new Set([
  ".yml",
  ".yaml",
  ".conf",
  ".json",
  ".toml",
  ".properties",
  ".txt",
]);

/** Directory name segments to skip (case-insensitive). */
const SKIP_DIR_NAMES = new Set([
  "userdata",
  "user-data",
  "cache",
  "logs",
  "maps",
  ".git",
]);

/** @type {Set<string>} */
const SKIP_FILE_EXTENSIONS = new Set([
  ".jar",
  ".db",
  ".db-shm",
  ".db-wal",
  ".h2.db",
  ".mv.db",
  ".pem",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".zip",
  ".gz",
  ".tar",
  ".bin",
  ".dat",
  ".litematic",
  ".schem",
  ".schematic",
]);

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Normalize to forward-slash relative path without leading ./ or /.
 * @param {string} p
 */
export function normalizeRelPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

/**
 * @param {string} relUnderPlugins e.g. Geyser-Spigot/config.yml
 */
export function extensionOf(relUnderPlugins) {
  const base = normalizeRelPath(relUnderPlugins).split("/").pop() || "";
  const lower = base.toLowerCase();
  if (lower.endsWith(".h2.db") || lower.endsWith(".mv.db")) {
    return lower.slice(lower.lastIndexOf(".", lower.length - 4));
  }
  const i = lower.lastIndexOf(".");
  return i >= 0 ? lower.slice(i) : "";
}

/**
 * Whether a path under plugins/ should be imported/applied.
 * @param {string} relUnderPlugins path relative to plugins/ (no plugins/ prefix)
 */
export function isPluginConfigPathAllowed(relUnderPlugins) {
  const rel = normalizeRelPath(relUnderPlugins);
  if (!rel || rel.includes("..") || rel.startsWith("plugins/")) return false;
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  for (let i = 0; i < parts.length - 1; i++) {
    if (SKIP_DIR_NAMES.has(parts[i].toLowerCase())) return false;
  }
  const file = parts[parts.length - 1];
  const fileLower = file.toLowerCase();
  if (fileLower === "key.pem" || fileLower.endsWith(".pem")) return false;
  if (fileLower.includes("secret") && fileLower.endsWith(".key")) return false;
  const ext = extensionOf(rel);
  if (SKIP_FILE_EXTENSIONS.has(ext)) return false;
  if (!CONFIG_LIKE_EXTENSIONS.has(ext)) return false;
  return true;
}

/**
 * @param {string} relUnderPlugins
 * @returns {string} plugins/<rel>
 */
export function toGuestRel(relUnderPlugins) {
  return `plugins/${normalizeRelPath(relUnderPlugins)}`;
}

/**
 * @param {string} guestRel plugins/<rel>
 * @returns {string | null} rel under plugins/
 */
export function fromGuestRel(guestRel) {
  const n = normalizeRelPath(guestRel);
  if (!n.startsWith("plugins/")) return null;
  const rest = n.slice("plugins/".length);
  return rest || null;
}

/**
 * Local sidecar relative to plugin-configs dir: `<rel>.json`
 * @param {string} relUnderPlugins
 */
export function toSidecarRel(relUnderPlugins) {
  return `${normalizeRelPath(relUnderPlugins)}.json`;
}

/**
 * @param {string} sidecarRel under plugin-configs/
 * @returns {string | null} rel under plugins/
 */
export function fromSidecarRel(sidecarRel) {
  const n = normalizeRelPath(sidecarRel);
  if (!n.endsWith(".json")) return null;
  return n.slice(0, -".json".length) || null;
}

/**
 * @param {Record<string, unknown> | null | undefined} cfg
 */
export function resolvePluginConfigsDirName(cfg) {
  if (isObject(cfg?.minecraft) && isObject(cfg.minecraft.plugin_configs)) {
    const dir = cfg.minecraft.plugin_configs.dir;
    if (typeof dir === "string" && dir.trim()) {
      const cleaned = normalizeRelPath(dir.trim());
      if (cleaned && !cleaned.includes("..")) return cleaned;
    }
  }
  return DEFAULT_PLUGIN_CONFIGS_DIR;
}

/**
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} resolved
 * @param {Record<string, unknown> | null | undefined} cfg
 */
export function resolvePluginConfigsDir(resolved, cfg) {
  if (!resolved?.found || !resolved.path) {
    throw new Error("minecraft config missing — cannot resolve plugin-configs dir");
  }
  return join(dirname(resolved.path), resolvePluginConfigsDirName(cfg));
}

/**
 * @param {string} content
 * @param {string} guestRel
 */
export function buildPluginConfigSidecar(content, guestRel) {
  return {
    guest_rel: normalizeRelPath(guestRel),
    content: String(content ?? ""),
  };
}

/**
 * @param {unknown} raw
 * @returns {{ guest_rel: string, content: string } | null}
 */
export function parsePluginConfigSidecar(raw) {
  if (!isObject(raw)) return null;
  const guestRel = typeof raw.guest_rel === "string" ? normalizeRelPath(raw.guest_rel) : "";
  if (!guestRel.startsWith("plugins/") || guestRel.includes("..")) return null;
  const under = fromGuestRel(guestRel);
  if (!under || !isPluginConfigPathAllowed(under)) return null;
  if (typeof raw.content !== "string") return null;
  return { guest_rel: guestRel, content: raw.content };
}

/**
 * @param {string} rootDir
 * @returns {{ abs: string, sidecarRel: string, guestRel: string, content: string }[]}
 */
export function listLocalPluginConfigSidecars(rootDir) {
  /** @type {{ abs: string, sidecarRel: string, guestRel: string, content: string }[]} */
  const out = [];
  if (!existsSync(rootDir)) return out;

  /**
   * @param {string} dir
   * @param {string} relPrefix
   */
  function walk(dir, relPrefix) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const abs = join(dir, name);
      if (ent.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!ent.isFile() || !name.endsWith(".json")) continue;
      const under = fromSidecarRel(rel);
      if (!under || !isPluginConfigPathAllowed(under)) continue;
      let raw;
      try {
        raw = JSON.parse(readFileSync(abs, "utf8"));
      } catch {
        continue;
      }
      const parsed = parsePluginConfigSidecar(raw);
      if (!parsed) continue;
      // Prefer guest_rel in file; fall back to path-derived.
      const expectedGuest = toGuestRel(under);
      if (parsed.guest_rel !== expectedGuest) {
        // Still accept if under-plugins matches after normalize
        const fromFile = fromGuestRel(parsed.guest_rel);
        if (fromFile !== under) continue;
      }
      out.push({
        abs,
        sidecarRel: normalizeRelPath(rel),
        guestRel: parsed.guest_rel,
        content: parsed.content,
      });
    }
  }

  walk(rootDir, "");
  out.sort((a, b) => a.sidecarRel.localeCompare(b.sidecarRel));
  return out;
}

/**
 * @param {string} rootDir
 * @param {string} relUnderPlugins
 * @param {string} content
 */
export function writePluginConfigSidecar(rootDir, relUnderPlugins, content) {
  const under = normalizeRelPath(relUnderPlugins);
  if (!isPluginConfigPathAllowed(under)) {
    throw new Error(`plugin config path not allowed: ${under}`);
  }
  const sidecarRel = toSidecarRel(under);
  const abs = join(rootDir, ...sidecarRel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  const payload = buildPluginConfigSidecar(content, toGuestRel(under));
  writeFileSync(abs, formatRepoJson(payload), "utf8");
  return { abs, sidecarRel, guestRel: payload.guest_rel };
}

/**
 * Remove local sidecars whose guest paths are not in keepSet (under-plugins rels).
 * @param {string} rootDir
 * @param {Set<string>} keepUnderPlugins
 */
export function prunePluginConfigSidecars(rootDir, keepUnderPlugins) {
  /** @type {string[]} */
  const removed = [];
  if (!existsSync(rootDir)) return removed;
  const listed = listLocalPluginConfigSidecars(rootDir);
  for (const item of listed) {
    const under = fromGuestRel(item.guestRel);
    if (under && keepUnderPlugins.has(under)) continue;
    try {
      rmSync(item.abs, { force: true });
      removed.push(item.sidecarRel);
    } catch {
      // ignore
    }
  }
  pruneEmptyDirs(rootDir);
  return removed;
}

/**
 * @param {string} rootDir
 */
function pruneEmptyDirs(rootDir) {
  if (!existsSync(rootDir)) return;
  /**
   * @param {string} dir
   * @returns {boolean} true if dir is empty / removed
   */
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    let empty = true;
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!walk(abs)) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && dir !== rootDir) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }
    return empty && dir !== rootDir;
  }
  walk(rootDir);
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").resolveMinecraftDeployments>[number]} deployment
 */
function resolveSshExec(deployment) {
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
    throw new Error(
      `${deployment.systemId}: configure.ssh.host or proxmox.qemu.ip required for plugin configs`,
    );
  }
  const sshUser = resolveGuestSshUser(sshCfg.user);
  return createConfigureExec("ssh", { user: sshUser, host: sshHost });
}

/**
 * @param {string} installDir
 */
function findPluginConfigsScript(installDir) {
  const dir = shellQuote(installDir.replace(/\/+$/, "") || "/opt/minecraft");
  // size\trel (rel under plugins/)
  return [
    "set -euo pipefail",
    `PLUGINS=${dir}/plugins`,
    'if [ ! -d "$PLUGINS" ]; then exit 0; fi',
    'find "$PLUGINS" -type f \\( \\',
    "  -name '*.yml' -o -name '*.yaml' -o -name '*.conf' -o -name '*.json' -o \\",
    "  -name '*.toml' -o -name '*.properties' -o -name '*.txt' \\",
    "\\) -printf '%s\\t%P\\n' 2>/dev/null || true",
  ].join("\n");
}

/**
 * @param {string} stdout
 * @returns {{ size: number, rel: string }[]}
 */
export function parseFindPluginConfigListing(stdout) {
  /** @type {{ size: number, rel: string }[]} */
  const out = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    if (tab < 0) continue;
    const size = Number(trimmed.slice(0, tab));
    const rel = normalizeRelPath(trimmed.slice(tab + 1));
    if (!Number.isFinite(size) || !rel) continue;
    out.push({ size, rel });
  }
  return out;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("./deployments.mjs").resolveMinecraftDeployments>[number]} opts.deployment
 * @param {string} [opts.installDir]
 * @param {(line: string) => void} [opts.log]
 */
export function listLivePluginConfigCandidates(opts) {
  const { deployment, installDir = "/opt/minecraft", log = () => {} } = opts;
  const exec = resolveSshExec(deployment);
  const dir = String(installDir || "/opt/minecraft").replace(/\/+$/, "") || "/opt/minecraft";
  log(`listing plugin config files under ${dir}/plugins …`);
  const r = exec.run(findPluginConfigsScript(dir), { capture: true });
  if (r.status !== 0) {
    throw new Error(`find plugin configs failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  const raw = parseFindPluginConfigListing(r.stdout || "");
  /** @type {{ size: number, rel: string }[]} */
  const allowed = [];
  /** @type {{ rel: string, reason: string }[]} */
  const skipped = [];
  for (const row of raw) {
    if (!isPluginConfigPathAllowed(row.rel)) {
      skipped.push({ rel: row.rel, reason: "deny-list" });
      continue;
    }
    if (row.size > PLUGIN_CONFIG_MAX_BYTES) {
      skipped.push({ rel: row.rel, reason: `size ${row.size} > ${PLUGIN_CONFIG_MAX_BYTES}` });
      continue;
    }
    allowed.push(row);
  }
  return { allowed, skipped, exec, installDir: dir };
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} absPath
 */
function readGuestFileBase64(exec, absPath) {
  const r = exec.run(`base64 -w0 ${shellQuote(absPath)} 2>/dev/null || base64 ${shellQuote(absPath)}`, {
    capture: true,
  });
  if (r.status !== 0) {
    throw new Error(`read ${absPath} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  const b64 = (r.stdout || "").replace(/\s+/g, "");
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} absPath
 * @param {string} content
 * @param {string} linuxUser
 */
function writeGuestFileBase64(exec, absPath, content, linuxUser) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const parent = dirname(absPath).replace(/\\/g, "/");
  const cmd = [
    `mkdir -p ${shellQuote(parent)}`,
    `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(absPath)}`,
    `chown ${shellQuote(linuxUser)}:${shellQuote(linuxUser)} ${shellQuote(absPath)} 2>/dev/null || true`,
  ].join(" && ");
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    throw new Error(`write ${absPath} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
}

/**
 * Pull live plugin configs into hdc-private plugin-configs/ (live-authoritative; prunes orphans).
 *
 * @param {object} opts
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} opts.resolved
 * @param {Record<string, unknown>} opts.cfg
 * @param {ReturnType<typeof import("./deployments.mjs").resolveMinecraftDeployments>[number]} opts.deployment
 * @param {(line: string) => void} [opts.log]
 */
export function importMinecraftPluginConfigsFromLive(opts) {
  const { resolved, cfg, deployment, log = () => {} } = opts;
  const installDir =
    isObject(cfg.minecraft) && typeof cfg.minecraft.install_dir === "string"
      ? cfg.minecraft.install_dir
      : "/opt/minecraft";
  const rootDir = resolvePluginConfigsDir(resolved, cfg);
  mkdirSync(rootDir, { recursive: true });

  const { allowed, skipped, exec, installDir: dir } = listLivePluginConfigCandidates({
    deployment,
    installDir,
    log,
  });
  for (const s of skipped) {
    log(`skip plugins/${s.rel}: ${s.reason}`);
  }

  /** @type {Set<string>} */
  const keep = new Set();
  /** @type {string[]} */
  const written = [];
  for (const row of allowed) {
    const abs = `${dir}/plugins/${row.rel}`;
    const content = readGuestFileBase64(exec, abs);
    if (Buffer.byteLength(content, "utf8") > PLUGIN_CONFIG_MAX_BYTES) {
      log(`skip plugins/${row.rel}: decoded size exceeds cap`);
      continue;
    }
    writePluginConfigSidecar(rootDir, row.rel, content);
    keep.add(row.rel);
    written.push(row.rel);
    log(`wrote plugins/${row.rel} → ${toSidecarRel(row.rel)}`);
  }

  const pruned = prunePluginConfigSidecars(rootDir, keep);
  for (const p of pruned) {
    log(`pruned stale sidecar ${p}`);
  }

  return {
    ok: true,
    dir: resolvePluginConfigsDirName(cfg),
    written: written.length,
    skipped: skipped.length,
    pruned: pruned.length,
    files: written,
  };
}

/**
 * Push hdc-private plugin-configs/ onto the guest (hdc-private is source of truth).
 *
 * @param {object} opts
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} opts.resolved
 * @param {Record<string, unknown>} opts.cfg
 * @param {ReturnType<typeof import("./deployments.mjs").resolveMinecraftDeployments>[number]} opts.deployment
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.restart] default true when any write occurs
 */
export function applyMinecraftPluginConfigsToGuest(opts) {
  const {
    resolved,
    cfg,
    deployment,
    log = () => {},
    dryRun = false,
    restart = true,
  } = opts;
  const installDir =
    isObject(cfg.minecraft) && typeof cfg.minecraft.install_dir === "string"
      ? cfg.minecraft.install_dir
      : "/opt/minecraft";
  const dir = String(installDir || "/opt/minecraft").replace(/\/+$/, "") || "/opt/minecraft";
  const rootDir = resolvePluginConfigsDir(resolved, cfg);
  const sidecars = listLocalPluginConfigSidecars(rootDir);
  if (sidecars.length === 0) {
    log(`no plugin-configs under ${resolvePluginConfigsDirName(cfg)} — skip apply`);
    return {
      ok: true,
      skipped: true,
      written: 0,
      planned: 0,
      restarted: false,
    };
  }

  const install = isObject(deployment.install) ? deployment.install : {};
  const linuxUser = resolveLinuxUser(/** @type {Record<string, unknown>} */ (install));
  const exec = resolveSshExec(deployment);

  /** @type {string[]} */
  const planned = [];
  /** @type {string[]} */
  const written = [];
  let anyChange = false;

  for (const item of sidecars) {
    const under = fromGuestRel(item.guestRel);
    if (!under) continue;
    const abs = `${dir}/${item.guestRel}`;
    planned.push(item.guestRel);
    if (dryRun) {
      log(`dry-run would write ${abs}`);
      continue;
    }
    let live = null;
    try {
      live = readGuestFileBase64(exec, abs);
    } catch {
      live = null;
    }
    if (live === item.content) {
      log(`unchanged ${item.guestRel}`);
      continue;
    }
    writeGuestFileBase64(exec, abs, item.content, linuxUser);
    written.push(item.guestRel);
    anyChange = true;
    log(`applied ${item.guestRel}`);
  }

  let restarted = false;
  if (!dryRun && restart && anyChange) {
    log("restarting minecraft.service after plugin config apply …");
    const r = exec.run("systemctl restart minecraft", { capture: true });
    if (r.status !== 0) {
      throw new Error(`systemctl restart minecraft failed: ${(r.stderr || r.stdout || "").trim()}`);
    }
    restarted = true;
  }

  return {
    ok: true,
    skipped: false,
    dry_run: dryRun,
    planned: planned.length,
    written: dryRun ? 0 : written.length,
    files: dryRun ? planned : written,
    restarted,
  };
}
