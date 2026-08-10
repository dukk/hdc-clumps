/**
 * Import / apply Minecraft plugin config trees as native-format files in hdc-private.
 *
 * Guest `$install_dir/plugins/<rel>` ↔ local `plugin-configs/<rel>` (same extension; raw content).
 * Logs are imported for archival but never applied on maintain.
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

import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { resolveLinuxUser } from "./minecraft-install.mjs";

export const PLUGIN_CONFIG_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PLUGIN_CONFIGS_DIR = "plugin-configs";
/** Base64 chunk size for SSH `printf` writes (stay under Windows CreateProcess ~32KiB). */
export const WRITE_GUEST_FILE_B64_CHUNK = 4096;

/** @type {Set<string>} */
export const CONFIG_LIKE_EXTENSIONS = new Set([
  ".yml",
  ".yaml",
  ".conf",
  ".json",
  ".toml",
  ".properties",
  ".txt",
  ".log",
]);

/** Directory name segments skipped for both import and apply (except logs — handled separately). */
const SKIP_DIR_NAMES = new Set([
  "userdata",
  "user-data",
  "cache",
  "maps",
  ".git",
  ".archive-unpack",
  "translations",
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
  if (lower.endsWith(".h2.db")) return ".h2.db";
  if (lower.endsWith(".mv.db")) return ".mv.db";
  const i = lower.lastIndexOf(".");
  return i >= 0 ? lower.slice(i) : "";
}

/**
 * Log files: under a `logs/` segment, `*.log`, or `*-log.txt` / `*log*.txt`.
 * @param {string} relUnderPlugins
 */
export function isPluginLogPath(relUnderPlugins) {
  const rel = normalizeRelPath(relUnderPlugins);
  if (!rel) return false;
  const parts = rel.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].toLowerCase() === "logs") return true;
  }
  const file = (parts[parts.length - 1] || "").toLowerCase();
  if (file.endsWith(".log")) return true;
  if (file.endsWith(".txt") && (file.includes("-log") || file.includes("log"))) return true;
  return false;
}

/**
 * Shared hard deny (path escape, junk dirs, secrets, binaries).
 * Does not decide logs — callers use import/apply helpers.
 * @param {string} relUnderPlugins
 */
function isHardDenied(relUnderPlugins) {
  const rel = normalizeRelPath(relUnderPlugins);
  if (!rel || rel.includes("..") || rel.startsWith("plugins/")) return true;
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 0) return true;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i].toLowerCase();
    if (SKIP_DIR_NAMES.has(seg)) return true;
  }
  const file = parts[parts.length - 1];
  const fileLower = file.toLowerCase();
  if (fileLower === "key.pem" || fileLower.endsWith(".pem")) return true;
  if (fileLower.includes("secret") && fileLower.endsWith(".key")) return true;
  // Backup dumps like configBackup0808262316.yml
  if (/backup/i.test(fileLower)) return true;
  const ext = extensionOf(rel);
  if (SKIP_FILE_EXTENSIONS.has(ext)) return true;
  if (!CONFIG_LIKE_EXTENSIONS.has(ext)) return true;
  return false;
}

/**
 * Whether a path may be imported (includes logs).
 * @param {string} relUnderPlugins
 */
export function isPluginConfigPathAllowedForImport(relUnderPlugins) {
  if (isHardDenied(relUnderPlugins)) return false;
  return true;
}

/**
 * Whether a path may be applied on maintain (excludes logs).
 * @param {string} relUnderPlugins
 */
export function isPluginConfigPathAllowedForApply(relUnderPlugins) {
  if (isHardDenied(relUnderPlugins)) return false;
  if (isPluginLogPath(relUnderPlugins)) return false;
  return true;
}

/**
 * @deprecated Prefer isPluginConfigPathAllowedForImport / ForApply
 * @param {string} relUnderPlugins
 */
export function isPluginConfigPathAllowed(relUnderPlugins) {
  return isPluginConfigPathAllowedForImport(relUnderPlugins);
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
 * Local path relative to plugin-configs dir (native format).
 * @param {string} relUnderPlugins
 */
export function toSidecarRel(relUnderPlugins) {
  return normalizeRelPath(relUnderPlugins);
}

/**
 * @param {string} sidecarRel under plugin-configs/
 * @returns {string | null} rel under plugins/
 */
export function fromSidecarRel(sidecarRel) {
  const n = normalizeRelPath(sidecarRel);
  return n || null;
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
 * Convert legacy `{ guest_rel, content }` JSON wrappers to native files; delete wrappers.
 * @param {string} rootDir
 * @param {(line: string) => void} [log]
 * @returns {number} converted count
 */
export function convertLegacyPluginConfigWrappers(rootDir, log = () => {}) {
  if (!existsSync(rootDir)) return 0;
  let converted = 0;

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
      let raw;
      try {
        raw = JSON.parse(readFileSync(abs, "utf8"));
      } catch {
        continue;
      }
      if (!isObject(raw) || typeof raw.guest_rel !== "string" || typeof raw.content !== "string") {
        continue;
      }
      const under = fromGuestRel(normalizeRelPath(raw.guest_rel));
      if (!under || !isPluginConfigPathAllowedForImport(under)) {
        try {
          rmSync(abs, { force: true });
        } catch {
          // ignore
        }
        continue;
      }
      writePluginConfigFile(rootDir, under, raw.content);
      try {
        rmSync(abs, { force: true });
      } catch {
        // ignore
      }
      converted += 1;
      log(`converted legacy wrapper ${rel} → ${under}`);
    }
  }

  walk(rootDir, "");
  pruneEmptyDirs(rootDir);
  return converted;
}

/**
 * @param {string} rootDir
 * @param {{ forApply?: boolean }} [opts]
 * @returns {{ abs: string, sidecarRel: string, guestRel: string, content: string }[]}
 */
export function listLocalPluginConfigFiles(rootDir, opts = {}) {
  const forApply = opts.forApply === true;
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
      if (!ent.isFile()) continue;
      // Skip leftover legacy wrappers (object JSON with guest_rel)
      if (name.endsWith(".json")) {
        try {
          const peek = JSON.parse(readFileSync(abs, "utf8"));
          if (isObject(peek) && typeof peek.guest_rel === "string" && typeof peek.content === "string") {
            continue;
          }
        } catch {
          // native .json plugin config — fall through
        }
      }
      const under = fromSidecarRel(rel);
      if (!under) continue;
      const allow = forApply
        ? isPluginConfigPathAllowedForApply(under)
        : isPluginConfigPathAllowedForImport(under);
      if (!allow) continue;
      let content;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      out.push({
        abs,
        sidecarRel: normalizeRelPath(rel),
        guestRel: toGuestRel(under),
        content,
      });
    }
  }

  walk(rootDir, "");
  out.sort((a, b) => a.sidecarRel.localeCompare(b.sidecarRel));
  return out;
}

/** @deprecated use listLocalPluginConfigFiles */
export function listLocalPluginConfigSidecars(rootDir) {
  return listLocalPluginConfigFiles(rootDir, { forApply: false });
}

/**
 * @param {string} rootDir
 * @param {string} relUnderPlugins
 * @param {string} content
 */
export function writePluginConfigFile(rootDir, relUnderPlugins, content) {
  const under = normalizeRelPath(relUnderPlugins);
  if (!isPluginConfigPathAllowedForImport(under)) {
    throw new Error(`plugin config path not allowed: ${under}`);
  }
  const sidecarRel = toSidecarRel(under);
  const abs = join(rootDir, ...sidecarRel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, String(content ?? ""), "utf8");
  return { abs, sidecarRel, guestRel: toGuestRel(under) };
}

/** @deprecated use writePluginConfigFile */
export function writePluginConfigSidecar(rootDir, relUnderPlugins, content) {
  return writePluginConfigFile(rootDir, relUnderPlugins, content);
}

/**
 * Remove local files whose guest paths are not in keepSet (under-plugins rels).
 * Also removes leftover legacy wrappers.
 * @param {string} rootDir
 * @param {Set<string>} keepUnderPlugins
 */
export function prunePluginConfigFiles(rootDir, keepUnderPlugins) {
  /** @type {string[]} */
  const removed = [];
  if (!existsSync(rootDir)) return removed;

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
      if (!ent.isFile()) continue;

      // Legacy wrapper
      if (name.endsWith(".json")) {
        try {
          const peek = JSON.parse(readFileSync(abs, "utf8"));
          if (isObject(peek) && typeof peek.guest_rel === "string" && typeof peek.content === "string") {
            const under = fromGuestRel(normalizeRelPath(peek.guest_rel));
            if (!under || !keepUnderPlugins.has(under)) {
              rmSync(abs, { force: true });
              removed.push(normalizeRelPath(rel));
            }
            continue;
          }
        } catch {
          // native json
        }
      }

      const under = fromSidecarRel(rel);
      if (!under) continue;
      if (keepUnderPlugins.has(under)) continue;
      try {
        rmSync(abs, { force: true });
        removed.push(normalizeRelPath(rel));
      } catch {
        // ignore
      }
    }
  }

  walk(rootDir, "");
  pruneEmptyDirs(rootDir);
  return removed;
}

/** @deprecated use prunePluginConfigFiles */
export function prunePluginConfigSidecars(rootDir, keepUnderPlugins) {
  return prunePluginConfigFiles(rootDir, keepUnderPlugins);
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
  return [
    "set -euo pipefail",
    `PLUGINS=${dir}/plugins`,
    'if [ ! -d "$PLUGINS" ]; then exit 0; fi',
    'find "$PLUGINS" -type f \\( \\',
    "  -name '*.yml' -o -name '*.yaml' -o -name '*.conf' -o -name '*.json' -o \\",
    "  -name '*.toml' -o -name '*.properties' -o -name '*.txt' -o -name '*.log' \\",
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
  /** @type {{ size: number, rel: string, is_log: boolean }[]} */
  const allowed = [];
  /** @type {{ rel: string, reason: string }[]} */
  const skipped = [];
  for (const row of raw) {
    if (!isPluginConfigPathAllowedForImport(row.rel)) {
      skipped.push({ rel: row.rel, reason: "deny-list" });
      continue;
    }
    if (row.size > PLUGIN_CONFIG_MAX_BYTES) {
      skipped.push({ rel: row.rel, reason: `size ${row.size} > ${PLUGIN_CONFIG_MAX_BYTES}` });
      continue;
    }
    allowed.push({ ...row, is_log: isPluginLogPath(row.rel) });
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
 * Split base64 into SSH-safe chunks for remote `printf` appends.
 * @param {string} b64
 * @param {number} [chunkSize]
 * @returns {string[]}
 */
export function chunkBase64ForRemoteWrite(b64, chunkSize = WRITE_GUEST_FILE_B64_CHUNK) {
  const size = Math.max(1, Number(chunkSize) || WRITE_GUEST_FILE_B64_CHUNK);
  const out = [];
  for (let i = 0; i < b64.length; i += size) {
    out.push(b64.slice(i, i + size));
  }
  return out;
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
  const tmpB64 = `${absPath}.hdc-b64.tmp`;
  const runOrThrow = (cmd, label) => {
    const r = exec.run(cmd, { capture: true });
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
      throw new Error(`write ${absPath} failed (${label}): ${detail}`);
    }
  };

  runOrThrow(`mkdir -p ${shellQuote(parent)} && : > ${shellQuote(tmpB64)}`, "init");
  for (const chunk of chunkBase64ForRemoteWrite(b64)) {
    runOrThrow(`printf %s ${shellQuote(chunk)} >> ${shellQuote(tmpB64)}`, "chunk");
  }
  runOrThrow(
    [
      `base64 -d ${shellQuote(tmpB64)} > ${shellQuote(absPath)}`,
      `rm -f ${shellQuote(tmpB64)}`,
      `chown ${shellQuote(linuxUser)}:${shellQuote(linuxUser)} ${shellQuote(absPath)} 2>/dev/null || true`,
    ].join(" && "),
    "decode",
  );
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} action start|stop
 */
function systemctlMinecraft(exec, action) {
  const r = exec.run(`systemctl ${action} minecraft`, { capture: true });
  if (r.status !== 0) {
    throw new Error(`systemctl ${action} minecraft failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
}

/**
 * Pull live plugin configs into hdc-private plugin-configs/ as native files.
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

  const converted = convertLegacyPluginConfigWrappers(rootDir, log);
  if (converted > 0) log(`converted ${converted} legacy JSON wrappers`);

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
  let logs = 0;
  for (const row of allowed) {
    const abs = `${dir}/plugins/${row.rel}`;
    const content = readGuestFileBase64(exec, abs);
    if (Buffer.byteLength(content, "utf8") > PLUGIN_CONFIG_MAX_BYTES) {
      log(`skip plugins/${row.rel}: decoded size exceeds cap`);
      continue;
    }
    writePluginConfigFile(rootDir, row.rel, content);
    keep.add(row.rel);
    written.push(row.rel);
    if (row.is_log) logs += 1;
    log(`wrote plugins/${row.rel} → ${toSidecarRel(row.rel)}${row.is_log ? " (log, apply-excluded)" : ""}`);
  }

  const pruned = prunePluginConfigFiles(rootDir, keep);
  for (const p of pruned) {
    log(`pruned stale file ${p}`);
  }

  return {
    ok: true,
    dir: resolvePluginConfigsDirName(cfg),
    written: written.length,
    logs,
    skipped: skipped.length,
    pruned: pruned.length,
    converted,
    files: written,
  };
}

/**
 * Build apply plan: files that differ from live (excludes logs).
 *
 * @param {object} opts
 * @param {{ abs: string, sidecarRel: string, guestRel: string, content: string }[]} opts.localFiles
 * @param {string} opts.installDir
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {(line: string) => void} [opts.log]
 * @returns {{ guest_rel: string, action: "create" | "update" }[]}
 */
export function buildPluginConfigApplyPlan(opts) {
  const { localFiles, installDir, exec, log = () => {} } = opts;
  const dir = String(installDir || "/opt/minecraft").replace(/\/+$/, "") || "/opt/minecraft";
  /** @type {{ guest_rel: string, action: "create" | "update", content: string }[]} */
  const plan = [];
  for (const item of localFiles) {
    const under = fromGuestRel(item.guestRel);
    if (!under || !isPluginConfigPathAllowedForApply(under)) continue;
    const abs = `${dir}/${item.guestRel}`;
    let live = null;
    let missing = false;
    try {
      live = readGuestFileBase64(exec, abs);
    } catch {
      missing = true;
      live = null;
    }
    if (!missing && live === item.content) {
      log(`unchanged ${item.guestRel}`);
      continue;
    }
    const action = missing ? "create" : "update";
    plan.push({ guest_rel: item.guestRel, action, content: item.content });
    log(`plan ${action} ${item.guestRel}`);
  }
  return plan;
}

/**
 * Push hdc-private plugin-configs/ onto the guest (hdc-private is source of truth).
 * Plans diffs while server is up; stops only when changes exist; writes only planned files; starts.
 *
 * @param {object} opts
 * @param {import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile} opts.resolved
 * @param {Record<string, unknown>} opts.cfg
 * @param {ReturnType<typeof import("./deployments.mjs").resolveMinecraftDeployments>[number]} opts.deployment
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.dryRun]
 */
export function applyMinecraftPluginConfigsToGuest(opts) {
  const { resolved, cfg, deployment, log = () => {}, dryRun = false } = opts;
  const installDir =
    isObject(cfg.minecraft) && typeof cfg.minecraft.install_dir === "string"
      ? cfg.minecraft.install_dir
      : "/opt/minecraft";
  const dir = String(installDir || "/opt/minecraft").replace(/\/+$/, "") || "/opt/minecraft";
  const rootDir = resolvePluginConfigsDir(resolved, cfg);

  convertLegacyPluginConfigWrappers(rootDir, log);

  const localFiles = listLocalPluginConfigFiles(rootDir, { forApply: true });
  if (localFiles.length === 0) {
    log(`no applyable plugin-configs under ${resolvePluginConfigsDirName(cfg)} — skip apply`);
    return {
      ok: true,
      skipped: true,
      written: 0,
      planned: 0,
      plan: [],
      stopped: false,
      started: false,
    };
  }

  const install = isObject(deployment.install) ? deployment.install : {};
  const linuxUser = resolveLinuxUser(/** @type {Record<string, unknown>} */ (install));
  const exec = resolveSshExec(deployment);

  log(`building plugin-config apply plan (${localFiles.length} local applyable files) …`);
  const plan = buildPluginConfigApplyPlan({
    localFiles,
    installDir: dir,
    exec,
    log,
  });

  if (plan.length === 0) {
    log("plugin-config plan empty — no stop/start");
    return {
      ok: true,
      skipped: false,
      dry_run: dryRun,
      written: 0,
      planned: 0,
      plan: [],
      stopped: false,
      started: false,
    };
  }

  log(`plugin-config plan: ${plan.length} file(s) to write`);
  for (const row of plan) {
    log(`  ${row.action} ${row.guest_rel}`);
  }

  if (dryRun) {
    return {
      ok: true,
      skipped: false,
      dry_run: true,
      written: 0,
      planned: plan.length,
      plan: plan.map((p) => ({ guest_rel: p.guest_rel, action: p.action })),
      stopped: false,
      started: false,
    };
  }

  log("stopping minecraft.service before plugin-config apply …");
  systemctlMinecraft(exec, "stop");
  let stopped = true;
  let started = false;
  /** @type {string[]} */
  const written = [];
  try {
    for (const row of plan) {
      const abs = `${dir}/${row.guest_rel}`;
      writeGuestFileBase64(exec, abs, row.content, linuxUser);
      written.push(row.guest_rel);
      log(`applied ${row.guest_rel}`);
    }
  } finally {
    try {
      log("starting minecraft.service after plugin-config apply …");
      systemctlMinecraft(exec, "start");
      started = true;
    } catch (e) {
      if (written.length === plan.length) throw e;
      throw new Error(
        `plugin-config write incomplete (${written.length}/${plan.length}); start also failed: ${
          /** @type {Error} */ (e).message || e
        }`,
      );
    }
  }

  return {
    ok: true,
    skipped: false,
    dry_run: false,
    written: written.length,
    planned: plan.length,
    plan: plan.map((p) => ({ guest_rel: p.guest_rel, action: p.action })),
    files: written,
    stopped,
    started,
  };
}
