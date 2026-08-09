import { stderr as errout } from "node:process";

import { resolveWhitelistPlayers, toPaperWhitelistPlayers } from "./floodgate-uuid.mjs";

/** PaperMC Fill v3 (api.papermc.io/v2 sunset → HTTP 410). */
const PAPER_FILL_API = "https://fill.papermc.io/v3/projects/paper";
const PAPER_USER_AGENT = "hdc-minecraft/1.0 (https://github.com/dukk/hdc-clumps)";
const GEYSER_SPIGOT_URL =
  "https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot";
const FLOODGATE_SPIGOT_URL =
  "https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot";
const GITHUB_API = "https://api.github.com";
const MODRINTH_API = "https://api.modrinth.com/v2";
const HANGAR_API = "https://hangar.papermc.io/api/v1";
const LUCKPERMS_DOWNLOADS_URL = "https://metadata.luckperms.net/data/downloads";
const CFWIDGET_BUKKIT_API = "https://api.cfwidget.com/minecraft/bukkit-plugins";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} install
 */
export function resolveLinuxUser(install) {
  const raw =
    typeof install.linux_user === "string" && install.linux_user.trim()
      ? install.linux_user.trim()
      : "minecraft";
  if (!/^[a-z][a-z0-9_-]*$/.test(raw)) {
    throw new Error(`install.linux_user invalid: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Fill v3 `versions` is `{ "<group>": ["<ver>", …], … }` with newest group first.
 * @param {unknown} versionsObj
 * @returns {string[]}
 */
export function flattenPaperVersions(versionsObj) {
  if (!isObject(versionsObj)) return [];
  /** @type {string[]} */
  const out = [];
  for (const list of Object.values(versionsObj)) {
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const s = String(v).trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Prefer STABLE channel; otherwise newest build (array is newest-first).
 * @param {unknown} builds
 */
export function pickPaperBuild(builds) {
  if (!Array.isArray(builds) || !builds.length) return null;
  const objs = builds.filter(isObject);
  const stable = objs.find((b) => String(b.channel || "").toUpperCase() === "STABLE");
  return stable || objs[0] || null;
}

/**
 * @param {unknown} assets
 * @param {RegExp} nameRe
 * @returns {string | null}
 */
export function pickGithubReleaseAsset(assets, nameRe) {
  if (!Array.isArray(assets)) return null;
  const hit = assets.find((a) => isObject(a) && nameRe.test(String(a.name || "")));
  const url =
    hit && typeof hit.browser_download_url === "string" ? hit.browser_download_url.trim() : "";
  return url || null;
}

/**
 * @param {unknown} versions
 * @param {string[]} [preferredLoaders]
 * @returns {string | null}
 */
export function pickModrinthPrimaryUrl(versions, preferredLoaders = ["paper", "spigot", "bukkit"]) {
  if (!Array.isArray(versions) || !versions.length) return null;
  const objs = versions.filter(isObject);
  const preferred = preferredLoaders?.length
    ? objs.find(
        (v) =>
          Array.isArray(v.loaders) &&
          v.loaders.some((l) => preferredLoaders.includes(String(l))),
      )
    : objs[0];
  if (!preferred) return null;
  const files = Array.isArray(preferred.files) ? preferred.files.filter(isObject) : [];
  const primary = files.find((f) => f.primary) || files[0];
  const url = primary && typeof primary.url === "string" ? primary.url.trim() : "";
  return url || null;
}

/**
 * @param {unknown} versionsPayload Hangar `{ result: [...] }` or a single version
 * @param {string} [platform]
 * @returns {string | null}
 */
export function pickHangarDownloadUrl(versionsPayload, platform = "PAPER") {
  const plat = String(platform || "PAPER").toUpperCase();
  /** @type {unknown[]} */
  let versions = [];
  if (Array.isArray(versionsPayload)) versions = versionsPayload;
  else if (isObject(versionsPayload) && Array.isArray(versionsPayload.result)) {
    versions = versionsPayload.result;
  } else if (isObject(versionsPayload)) {
    versions = [versionsPayload];
  }
  const objs = versions.filter(isObject);
  const isRelease = (v) => {
    const ch = isObject(v.channel) ? String(v.channel.name || "") : "";
    return /^release$/i.test(ch);
  };
  const ordered = [...objs.filter(isRelease), ...objs.filter((v) => !isRelease(v))];
  for (const v of ordered) {
    const downloads = isObject(v.downloads) ? v.downloads : {};
    const platDl = isObject(downloads[plat]) ? downloads[plat] : null;
    const url = platDl && typeof platDl.downloadUrl === "string" ? platDl.downloadUrl.trim() : "";
    if (url) return url;
  }
  return null;
}

/**
 * @param {unknown} meta LuckPerms `/data/downloads`
 * @returns {string | null}
 */
export function pickLuckPermsBukkitUrl(meta) {
  if (!isObject(meta)) return null;
  const downloads = isObject(meta.downloads) ? meta.downloads : {};
  const url = typeof downloads.bukkit === "string" ? downloads.bukkit.trim() : "";
  return url || null;
}

/**
 * CurseForge file id → mediafilez CDN path (`8024433` → `8024/433`).
 * @param {unknown} meta cfwidget project JSON
 * @returns {string | null}
 */
export function pickCfwidgetForgecdnUrl(meta) {
  if (!isObject(meta)) return null;
  const dl = isObject(meta.download) ? meta.download : null;
  if (!dl) return null;
  const id = Number(dl.id);
  const name = typeof dl.name === "string" ? dl.name.trim() : "";
  if (!Number.isFinite(id) || id <= 0 || !/^[A-Za-z0-9._+-]+$/.test(name)) return null;
  const idStr = String(Math.trunc(id));
  if (idStr.length < 5) return null;
  return `https://mediafilez.forgecdn.net/files/${idStr.slice(0, 4)}/${idStr.slice(4)}/${name}`;
}

/**
 * Skip ancient 1.19.x Requests jars; 1.21.x / 26.x assets are current enough.
 * @param {string} [assetName]
 * @param {string} [tagName]
 */
export function isRequestsJarCurrentEnough(assetName, tagName) {
  const name = String(assetName || "").trim();
  const tag = String(tagName || "").trim();
  if (!/\.jar$/i.test(name)) return false;
  const text = `${name} ${tag}`.toLowerCase();
  if (/\b1\.19(\.|x|\b)/.test(text) && !/\b1\.2[0-9]/.test(text) && !/\b26\./.test(text)) {
    return false;
  }
  return true;
}

/**
 * @param {string} url
 */
async function paperFillFetch(url) {
  return fetch(url, {
    headers: { Accept: "application/json", "User-Agent": PAPER_USER_AGENT },
  });
}

/**
 * @param {string} url
 */
async function githubJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": PAPER_USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * @param {string} repo
 * @param {RegExp} nameRe
 */
export async function resolveGithubReleaseAsset(repo, nameRe) {
  errout.write(`[hdc] minecraft install: resolving GitHub ${repo} …\n`);
  const rel = await githubJson(`${GITHUB_API}/repos/${repo}/releases/latest`);
  const url = pickGithubReleaseAsset(isObject(rel) ? rel.assets : [], nameRe);
  if (!url) throw new Error(`${repo}: no release asset matching ${nameRe}`);
  errout.write(`[hdc] minecraft install: ${repo} → ${url.split("/").pop()}\n`);
  return url;
}

/**
 * @param {string} repo
 * @param {{ dest: string, re: RegExp }[]} matchers
 * @returns {Promise<{ dest: string, url: string }[]>}
 */
export async function resolveGithubReleaseAssets(repo, matchers) {
  errout.write(`[hdc] minecraft install: resolving GitHub ${repo} (${matchers.length} assets) …\n`);
  const rel = await githubJson(`${GITHUB_API}/repos/${repo}/releases/latest`);
  const assets = isObject(rel) ? rel.assets : [];
  return matchers.map(({ dest, re }) => {
    const url = pickGithubReleaseAsset(assets, re);
    if (!url) throw new Error(`${repo}: no asset matching ${re} for ${dest}`);
    errout.write(`[hdc] minecraft install: ${repo} ${dest} → ${url.split("/").pop()}\n`);
    return { dest, url };
  });
}

/**
 * @param {string} projectId
 * @param {string[]} [preferredLoaders]
 */
export async function resolveModrinthPluginUrl(
  projectId,
  preferredLoaders = ["paper", "spigot", "bukkit"],
) {
  errout.write(`[hdc] minecraft install: resolving Modrinth ${projectId} …\n`);
  const qs = new URLSearchParams();
  if (preferredLoaders?.length) qs.set("loaders", JSON.stringify(preferredLoaders));
  const url = `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version${
    qs.toString() ? `?${qs}` : ""
  }`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": PAPER_USER_AGENT },
  });
  if (!res.ok) throw new Error(`Modrinth ${projectId} HTTP ${res.status}`);
  const versions = await res.json();
  const download = pickModrinthPrimaryUrl(versions, preferredLoaders);
  if (!download) throw new Error(`Modrinth ${projectId}: no download url for loaders ${preferredLoaders.join(",")}`);
  errout.write(`[hdc] minecraft install: Modrinth ${projectId} → ${download.split("/").pop()}\n`);
  return download;
}

/**
 * @param {string} author
 * @param {string} slug
 * @param {string} [platform]
 */
export async function resolveHangarPluginUrl(author, slug, platform = "PAPER") {
  const plat = String(platform || "PAPER").toUpperCase();
  errout.write(`[hdc] minecraft install: resolving Hangar ${author}/${slug} …\n`);
  const qs = new URLSearchParams({ limit: "25", platform: plat });
  const url = `${HANGAR_API}/projects/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/versions?${qs}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": PAPER_USER_AGENT },
  });
  if (!res.ok) throw new Error(`Hangar ${author}/${slug} HTTP ${res.status}`);
  const download = pickHangarDownloadUrl(await res.json(), plat);
  if (!download) throw new Error(`Hangar ${author}/${slug}: no ${plat} download url`);
  errout.write(`[hdc] minecraft install: Hangar ${author}/${slug} → ${download.split("/").pop()}\n`);
  return download;
}

export async function resolveLuckPermsBukkitUrl() {
  errout.write(`[hdc] minecraft install: resolving LuckPerms bukkit …\n`);
  const res = await fetch(LUCKPERMS_DOWNLOADS_URL, {
    headers: { Accept: "application/json", "User-Agent": PAPER_USER_AGENT },
  });
  if (!res.ok) throw new Error(`LuckPerms metadata HTTP ${res.status}`);
  const download = pickLuckPermsBukkitUrl(await res.json());
  if (!download) throw new Error("LuckPerms metadata: missing downloads.bukkit");
  errout.write(`[hdc] minecraft install: LuckPerms → ${download.split("/").pop()}\n`);
  return download;
}

/**
 * @param {string} slug CurseForge/Bukkit project slug
 */
export async function resolveCfwidgetBukkitJar(slug) {
  errout.write(`[hdc] minecraft install: resolving CurseForge/Bukkit ${slug} …\n`);
  const res = await fetch(`${CFWIDGET_BUKKIT_API}/${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json", "User-Agent": PAPER_USER_AGENT },
  });
  if (!res.ok) throw new Error(`cfwidget ${slug} HTTP ${res.status}`);
  const download = pickCfwidgetForgecdnUrl(await res.json());
  if (!download) throw new Error(`cfwidget ${slug}: no forgecdn download`);
  errout.write(`[hdc] minecraft install: ${slug} → ${download.split("/").pop()}\n`);
  return download;
}

/** @returns {Promise<string | null>} */
export async function resolveRequestsPluginUrl() {
  errout.write(`[hdc] minecraft install: resolving GitHub theMackabu/requests …\n`);
  try {
    const rel = await githubJson(`${GITHUB_API}/repos/theMackabu/requests/releases/latest`);
    const tag = isObject(rel) ? String(rel.tag_name || rel.name || "") : "";
    const url = pickGithubReleaseAsset(isObject(rel) ? rel.assets : [], /^requests-.*\.jar$/i);
    const name = url ? url.split("/").pop() || "" : "";
    if (!url || !isRequestsJarCurrentEnough(name, tag)) {
      errout.write(
        `[hdc] minecraft install: warning: requests latest is not a modern Paper jar (${name || tag || "none"}); skipping (do not UniFi-forward extra HTTP).\n`,
      );
      return null;
    }
    errout.write(`[hdc] minecraft install: requests → ${name}\n`);
    return url;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    errout.write(`[hdc] minecraft install: warning: requests resolve failed (${detail}); skipping.\n`);
    return null;
  }
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").mergeMinecraftSettings>} mc
 * @returns {Promise<{ dest: string, url: string }[]>}
 */
export async function resolvePluginJars(mc) {
  /** @type {{ dest: string, url: string }[]} */
  const jars = [];
  if (mc.geyser !== false) {
    jars.push({ dest: "Geyser-Spigot.jar", url: GEYSER_SPIGOT_URL });
  }
  if (mc.floodgate !== false) {
    jars.push({ dest: "floodgate-spigot.jar", url: FLOODGATE_SPIGOT_URL });
  }
  if (mc.vault) {
    jars.push({
      dest: "Vault.jar",
      url: await resolveGithubReleaseAsset("MilkBowl/Vault", /^Vault.*\.jar$/i),
    });
  }
  if (mc.essentialsx || mc.essentialsxChat || mc.essentialsxSpawn) {
    /** @type {{ dest: string, re: RegExp }[]} */
    const matchers = [];
    if (mc.essentialsx) matchers.push({ dest: "EssentialsX.jar", re: /^EssentialsX-\d/i });
    if (mc.essentialsxChat) matchers.push({ dest: "EssentialsXChat.jar", re: /^EssentialsXChat-/i });
    if (mc.essentialsxSpawn) {
      matchers.push({ dest: "EssentialsXSpawn.jar", re: /^EssentialsXSpawn-/i });
    }
    jars.push(...(await resolveGithubReleaseAssets("EssentialsX/Essentials", matchers)));
  }
  if (mc.worldedit || mc.worldguard) {
    jars.push({ dest: "WorldEdit.jar", url: await resolveModrinthPluginUrl("worldedit") });
  }
  if (mc.worldguard) {
    jars.push({ dest: "WorldGuard.jar", url: await resolveModrinthPluginUrl("worldguard") });
  }
  if (mc.bluemap) {
    jars.push({
      dest: "BlueMap.jar",
      url: await resolveGithubReleaseAsset(
        "BlueMap-Minecraft/BlueMap",
        /bluemap-.*-paper\.jar$/i,
      ),
    });
  }
  if (mc.treeFeller) {
    jars.push({
      dest: "TreeFeller.jar",
      url: await resolveGithubReleaseAsset(
        "ThizThizzyDizzy/tree-feller",
        /^TreeFeller-.*\.jar$/i,
      ),
    });
  }
  if (mc.chunky) {
    jars.push({
      dest: "Chunky.jar",
      url: await resolveModrinthPluginUrl("chunky", ["bukkit", "paper", "spigot"]),
    });
  }
  if (mc.deadChest) {
    jars.push({ dest: "DeadChest.jar", url: await resolveModrinthPluginUrl("dead-chest") });
  }
  if (mc.decentHolograms) {
    jars.push({
      dest: "DecentHolograms.jar",
      url: await resolveGithubReleaseAsset(
        "DecentSoftware-eu/DecentHolograms",
        /^DecentHolograms-.*\.jar$/i,
      ),
    });
  }
  if (mc.dropHeads) {
    jars.push({ dest: "DropHeads.jar", url: await resolveCfwidgetBukkitJar("dropheads") });
  }
  if (mc.luckperms) {
    jars.push({ dest: "LuckPerms.jar", url: await resolveLuckPermsBukkitUrl() });
  }
  if (mc.protocollib) {
    jars.push({
      dest: "ProtocolLib.jar",
      url: await resolveGithubReleaseAsset("dmulloy2/ProtocolLib", /^ProtocolLib\.jar$/i),
    });
  }
  if (mc.requests) {
    const requestsUrl = await resolveRequestsPluginUrl();
    if (requestsUrl) jars.push({ dest: "Requests.jar", url: requestsUrl });
  }
  if (mc.signshop) {
    jars.push({ dest: "SignShop.jar", url: await resolveCfwidgetBukkitJar("signshop") });
  }
  if (mc.silkSpawners) {
    jars.push({
      dest: "SilkSpawners.jar",
      url: await resolveGithubReleaseAsset("timbru31/SilkSpawners", /SilkSpawners.*\.jar$/i),
    });
  }
  if (mc.vanishNoPacket) {
    jars.push({
      dest: "VanishNoPacket.jar",
      url: await resolveHangarPluginUrl("Escape_Systems", "VanishNoPacket-Refined"),
    });
  }
  if (mc.worldeditSui) {
    jars.push({
      dest: "WorldEditSUI.jar",
      url: await resolveHangarPluginUrl("kennytv", "WorldEditSUI"),
    });
  }
  return jars;
}

/**
 * @param {string} versionPin
 */
export async function resolvePaperDownload(versionPin = "latest") {
  const pin = String(versionPin || "latest").trim() || "latest";
  errout.write(`[hdc] minecraft install: resolving PaperMC Fill download (${pin}) …\n`);
  const projRes = await paperFillFetch(PAPER_FILL_API);
  if (!projRes.ok) {
    throw new Error(`PaperMC Fill project API HTTP ${projRes.status}`);
  }
  const proj = await projRes.json();
  const versions = flattenPaperVersions(isObject(proj) ? proj.versions : null);
  if (!versions.length) throw new Error("PaperMC Fill API returned no versions");
  const version = pin === "latest" ? versions[0] : pin;
  if (!versions.includes(version)) {
    throw new Error(`Paper version ${JSON.stringify(version)} not on PaperMC Fill API`);
  }
  const buildsRes = await paperFillFetch(`${PAPER_FILL_API}/versions/${encodeURIComponent(version)}/builds`);
  if (!buildsRes.ok) {
    throw new Error(`PaperMC Fill builds API HTTP ${buildsRes.status} for ${version}`);
  }
  const buildsJson = await buildsRes.json();
  const meta = pickPaperBuild(buildsJson);
  if (!meta) throw new Error(`no Paper builds for ${version}`);
  const downloads = isObject(meta.downloads) ? meta.downloads : {};
  const application = isObject(downloads["server:default"]) ? downloads["server:default"] : {};
  const name = typeof application.name === "string" ? application.name.trim() : "";
  const url = typeof application.url === "string" ? application.url.trim() : "";
  if (!name || !url) {
    throw new Error(`Paper build ${version} #${meta.id ?? "?"} missing server:default download`);
  }
  const build = meta.id;
  errout.write(`[hdc] minecraft install: Paper ${version} build ${build} (${name})\n`);
  return { version, build, name, url };
}

const SERVER_PROP_KEY_RE = /^[a-z0-9._-]+$/i;

/**
 * @param {unknown} v
 */
function serverPropValue(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").mergeMinecraftSettings>} mc
 */
export function renderServerProperties(mc) {
  const motd = String(mc.motd ?? "HDC Minecraft").replace(/\r?\n/g, " ");
  /** @type {Record<string, string>} */
  const props = {
    "enable-query": "true",
    "sync-chunk-writes": "true",
  };
  const extra = mc.serverProperties && typeof mc.serverProperties === "object" ? mc.serverProperties : {};
  for (const [key, val] of Object.entries(extra)) {
    if (!SERVER_PROP_KEY_RE.test(key) || val == null) continue;
    props[key] = serverPropValue(val);
  }
  if (mc.whitelist) {
    props["white-list"] = mc.whitelist.enabled ? "true" : "false";
    props["enforce-whitelist"] = mc.whitelist.enforce ? "true" : "false";
  }
  props["server-port"] = String(mc.javaPort);
  props.motd = motd;
  props["max-players"] = String(mc.maxPlayers);
  props["online-mode"] = mc.onlineMode ? "true" : "false";
  props["query.port"] = String(mc.javaPort);
  return `${Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}

/**
 * @param {{ uuid: string, name: string, edition?: string }[]} players
 * @param {string} [floodgatePrefix]
 */
export function renderWhitelistJson(players, floodgatePrefix = ".") {
  return `${JSON.stringify(toPaperWhitelistPlayers(players, floodgatePrefix), null, 2)}\n`;
}

/**
 * @param {{ uuid: string, name: string, level: number, bypassesPlayerLimit: boolean }[]} ops
 */
export function renderOpsJson(ops) {
  return `${JSON.stringify(ops, null, 2)}\n`;
}

/**
 * @param {string} linuxUser
 * @param {string} installDir
 * @param {string} heapMin
 * @param {string} heapMax
 */
export function renderSystemdUnit(linuxUser, installDir, heapMin, heapMax) {
  return `[Unit]
Description=Paper Minecraft server
Documentation=https://papermc.io/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${linuxUser}
Group=${linuxUser}
WorkingDirectory=${installDir}
ExecStart=/usr/bin/java -Xms${heapMin} -Xmx${heapMax} -jar paper.jar nogui
Restart=on-failure
RestartSec=10
TimeoutStopSec=90
SuccessExitStatus=0 143

[Install]
WantedBy=multi-user.target
`;
}

/**
 * @param {{ dest: string, url: string }[]} pluginJars
 * @param {boolean} skipIfPresent
 * @returns {string[]}
 */
function renderPluginDownloadLines(pluginJars, skipIfPresent) {
  /** @type {string[]} */
  const lines = [];
  for (const jar of pluginJars) {
    const dest = String(jar.dest || "").trim();
    const url = String(jar.url || "").trim();
    if (!dest || !url || !/^[A-Za-z0-9._-]+$/.test(dest)) continue;
    const destRef = `"$INSTALL_DIR/plugins/${dest}"`;
    const urlQ = JSON.stringify(url);
    if (skipIfPresent) {
      lines.push(`if [ ! -f ${destRef} ]; then`, `  curl -fL# -A "$PAPER_UA" -o ${destRef} ${urlQ}`, "fi");
    } else {
      lines.push(`curl -fL# -A "$PAPER_UA" -o ${destRef} ${urlQ}`);
    }
  }
  return lines;
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.install
 * @param {ReturnType<typeof import("./deployments.mjs").mergeMinecraftSettings>} opts.minecraft
 * @param {{ version: string; build: number|string; name: string; url: string }} opts.paper
 * @param {{ dest: string, url: string }[]} [opts.pluginJars]
 * @param {{ skipJarDownload?: boolean }} [opts.flags]
 */
export function buildInstallShellScript(opts) {
  const linuxUser = resolveLinuxUser(opts.install);
  const mc = opts.minecraft;
  const paper = opts.paper;
  const skipJars = opts.flags?.skipJarDownload === true;
  const installDir = mc.installDir;
  const unit = renderSystemdUnit(linuxUser, installDir, mc.javaHeapMin, mc.javaHeap);
  const props = renderServerProperties(mc);
  const geyser = mc.geyser !== false;
  const floodgate = mc.floodgate !== false;
  const bluemap = mc.bluemap === true;
  const bluemapPort = Number(mc.bluemapWebPort) || 8100;
  /** @type {{ dest: string, url: string }[]} */
  let pluginJars = Array.isArray(opts.pluginJars) ? opts.pluginJars : [];
  if (!pluginJars.length) {
    if (geyser) pluginJars.push({ dest: "Geyser-Spigot.jar", url: GEYSER_SPIGOT_URL });
    if (floodgate) pluginJars.push({ dest: "floodgate-spigot.jar", url: FLOODGATE_SPIGOT_URL });
  }

  /** @type {string[]} */
  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "ROOT_PART=$(findmnt -n -o SOURCE / | sed 's/[0-9]*$//')",
    "ROOT_NUM=$(findmnt -n -o SOURCE / | grep -oE '[0-9]+$')",
    "if [ -n \"$ROOT_PART\" ] && [ -n \"$ROOT_NUM\" ]; then",
    "  growpart \"$ROOT_PART\" \"$ROOT_NUM\" 2>/dev/null || true",
    "  resize2fs \"$(findmnt -n -o SOURCE /)\" 2>/dev/null || true",
    "fi",
    "apt-get update -qq",
    "apt-get install -y -qq openjdk-25-jre-headless curl ca-certificates python3",
    `LINUX_USER=${JSON.stringify(linuxUser)}`,
    `INSTALL_DIR=${JSON.stringify(installDir)}`,
    "if ! id \"$LINUX_USER\" >/dev/null 2>&1; then",
    "  useradd -r -s /usr/sbin/nologin -U -m -d /var/lib/minecraft \"$LINUX_USER\" 2>/dev/null || useradd -r -s /sbin/nologin -U -m -d /var/lib/minecraft \"$LINUX_USER\"",
    "fi",
    "mkdir -p \"$INSTALL_DIR/plugins\" \"$INSTALL_DIR/plugins/Geyser-Spigot\"",
    mc.eula ? "printf 'eula=true\\n' > \"$INSTALL_DIR/eula.txt\"" : "printf 'eula=false\\n' > \"$INSTALL_DIR/eula.txt\"",
    `cat > "$INSTALL_DIR/server.properties" <<'PROPS'`,
    props.trimEnd(),
    "PROPS",
  ];

  if (mc.whitelist) {
    const prefix = typeof mc.floodgateUsernamePrefix === "string" ? mc.floodgateUsernamePrefix : ".";
    lines.push(
      `cat > "$INSTALL_DIR/whitelist.json" <<'WL'`,
      renderWhitelistJson(mc.whitelist.players, prefix).trimEnd(),
      "WL",
    );
  }
  if (mc.ops) {
    lines.push(
      `cat > "$INSTALL_DIR/ops.json" <<'OPS'`,
      renderOpsJson(mc.ops).trimEnd(),
      "OPS",
    );
  }

  lines.push(`PAPER_UA=${JSON.stringify(PAPER_USER_AGENT)}`);

  if (!skipJars) {
    lines.push(
      `PAPER_URL=${JSON.stringify(paper.url)}`,
      'curl -fL# -A "$PAPER_UA" -o "$INSTALL_DIR/paper.jar" "$PAPER_URL"',
      `echo ${JSON.stringify(`${paper.version}#${paper.build}`)} > "$INSTALL_DIR/.paper-version"`,
    );
  } else {
    lines.push('test -f "$INSTALL_DIR/paper.jar"');
  }
  lines.push(...renderPluginDownloadLines(pluginJars, skipJars));

  lines.push(
    `cat > /etc/systemd/system/minecraft.service <<'UNIT'`,
    unit.trimEnd(),
    "UNIT",
    "chown -R \"$LINUX_USER:$LINUX_USER\" \"$INSTALL_DIR\"",
    "systemctl daemon-reload",
    "systemctl enable -q minecraft",
    "systemctl restart minecraft || systemctl start minecraft",
  );

  const paperExtras = mc.paperExtras || {};
  const patchPaperWorld =
    paperExtras.perPlayerMobSpawns != null ||
    paperExtras.keepSpawnLoadedRange != null ||
    paperExtras.antiXray != null;
  const patchPaperUsername = floodgate;

  if (geyser || bluemap || patchPaperWorld || patchPaperUsername) {
    lines.push(
      geyser ? "NEED_GEYSER=1" : "NEED_GEYSER=0",
      bluemap ? "NEED_BLUEMAP=1" : "NEED_BLUEMAP=0",
      patchPaperWorld ? "NEED_PAPER_WORLD=1" : "NEED_PAPER_WORLD=0",
      patchPaperUsername ? "NEED_PAPER_GLOBAL=1" : "NEED_PAPER_GLOBAL=0",
      "i=0",
      "while [ \"$i\" -lt 90 ]; do",
      "  ok=1",
      "  if [ \"$NEED_GEYSER\" = 1 ] && [ ! -f \"$INSTALL_DIR/plugins/Geyser-Spigot/config.yml\" ]; then ok=0; fi",
      "  if [ \"$NEED_BLUEMAP\" = 1 ] && { [ ! -f \"$INSTALL_DIR/plugins/BlueMap/core.conf\" ] || [ ! -f \"$INSTALL_DIR/plugins/BlueMap/webserver.conf\" ]; }; then ok=0; fi",
      "  if [ \"$NEED_PAPER_WORLD\" = 1 ] && [ ! -f \"$INSTALL_DIR/config/paper-world-defaults.yml\" ]; then ok=0; fi",
      "  if [ \"$NEED_PAPER_GLOBAL\" = 1 ] && [ ! -f \"$INSTALL_DIR/config/paper-global.yml\" ]; then ok=0; fi",
      "  if [ \"$ok\" = 1 ]; then break; fi",
      "  sleep 3",
      "  i=$((i + 1))",
      "done",
      "PATCHED=0",
    );
  }

  if (geyser) {
    lines.push(
      "GEYSER_CFG=\"$INSTALL_DIR/plugins/Geyser-Spigot/config.yml\"",
      "if [ -f \"$GEYSER_CFG\" ]; then",
      "  python3 - \"$GEYSER_CFG\" <<'PY'",
      "import sys",
      "from pathlib import Path",
      "p = Path(sys.argv[1])",
      "text = p.read_text(encoding='utf-8', errors='replace')",
      "lines = text.splitlines()",
      "section = None",
      "out = []",
      "for line in lines:",
      "    stripped = line.strip()",
      "    if not line.startswith((' ', '\\t')) and stripped.endswith(':') and not stripped.startswith('#'):",
      "        section = stripped[:-1]",
      `    if section == 'bedrock' and stripped.startswith('port:'):`,
      `        out.append('  port: ${mc.bedrockPort}')`,
      "        continue",
      "    if section in ('java', 'remote') and stripped.startswith('auth-type:'):",
      "        out.append('  auth-type: floodgate')",
      "        continue",
      "    if section == 'remote' and stripped.startswith('address:'):",
      "        out.append('  address: auto')",
      "        continue",
      "    out.append(line)",
      "p.write_text('\\n'.join(out) + '\\n', encoding='utf-8')",
      "PY",
      "  PATCHED=1",
      "fi",
    );
  }

  if (bluemap) {
    lines.push(
      "BLUEMAP_CORE=\"$INSTALL_DIR/plugins/BlueMap/core.conf\"",
      "BLUEMAP_WEB=\"$INSTALL_DIR/plugins/BlueMap/webserver.conf\"",
      "if [ -f \"$BLUEMAP_CORE\" ]; then",
      "  python3 - \"$BLUEMAP_CORE\" <<'PY'",
      "import sys",
      "from pathlib import Path",
      "p = Path(sys.argv[1])",
      "updates = {'accept-download': 'true'}",
      "lines = p.read_text(encoding='utf-8', errors='replace').splitlines()",
      "seen = set()",
      "out = []",
      "for line in lines:",
      "    stripped = line.strip()",
      "    if stripped.startswith('#') or ':' not in stripped:",
      "        out.append(line)",
      "        continue",
      "    key = stripped.split(':', 1)[0].strip()",
      "    if key in updates:",
      "        indent = line[:len(line) - len(line.lstrip())]",
      "        out.append(f'{indent}{key}: {updates[key]}')",
      "        seen.add(key)",
      "        continue",
      "    out.append(line)",
      "for key, val in updates.items():",
      "    if key not in seen:",
      "        out.append(f'{key}: {val}')",
      "p.write_text('\\n'.join(out) + '\\n', encoding='utf-8')",
      "PY",
      "  PATCHED=1",
      "fi",
      "if [ -f \"$BLUEMAP_WEB\" ]; then",
      "  python3 - \"$BLUEMAP_WEB\" <<'PY'",
      "import sys",
      "from pathlib import Path",
      "p = Path(sys.argv[1])",
      `updates = {'enabled': 'true', 'port': '${bluemapPort}', 'ip': '"0.0.0.0"'}`,
      "lines = p.read_text(encoding='utf-8', errors='replace').splitlines()",
      "seen = set()",
      "out = []",
      "for line in lines:",
      "    stripped = line.strip()",
      "    if stripped.startswith('#') or ':' not in stripped:",
      "        out.append(line)",
      "        continue",
      "    key = stripped.split(':', 1)[0].strip()",
      "    if key in updates:",
      "        indent = line[:len(line) - len(line.lstrip())]",
      "        out.append(f'{indent}{key}: {updates[key]}')",
      "        seen.add(key)",
      "        continue",
      "    out.append(line)",
      "for key, val in updates.items():",
      "    if key not in seen:",
      "        out.append(f'{key}: {val}')",
      "p.write_text('\\n'.join(out) + '\\n', encoding='utf-8')",
      "PY",
      "  PATCHED=1",
      "fi",
    );
  }

  if (patchPaperUsername) {
    lines.push(
      "PAPER_GLOBAL=\"$INSTALL_DIR/config/paper-global.yml\"",
      "if [ -f \"$PAPER_GLOBAL\" ]; then",
      "  python3 - \"$PAPER_GLOBAL\" <<'PY'",
      "import sys",
      "from pathlib import Path",
      "p = Path(sys.argv[1])",
      "lines = p.read_text(encoding='utf-8', errors='replace').splitlines()",
      "out = []",
      "changed = False",
      "for line in lines:",
      "    stripped = line.strip()",
      "    indent = len(line) - len(line.lstrip(' '))",
      "    if stripped.startswith('perform-username-validation:'):",
      "        out.append(f\"{' ' * indent}perform-username-validation: false\")",
      "        changed = True",
      "        continue",
      "    out.append(line)",
      "if changed:",
      "    p.write_text('\\n'.join(out) + '\\n', encoding='utf-8')",
      "PY",
      "  PATCHED=1",
      "fi",
    );
  }

  if (patchPaperWorld) {
    const perPlayer =
      paperExtras.perPlayerMobSpawns != null ? String(paperExtras.perPlayerMobSpawns) : "";
    const spawnRange =
      paperExtras.keepSpawnLoadedRange != null ? String(paperExtras.keepSpawnLoadedRange) : "";
    const antiXray = paperExtras.antiXray != null ? String(paperExtras.antiXray) : "";
    lines.push(
      "PAPER_WORLD=\"$INSTALL_DIR/config/paper-world-defaults.yml\"",
      "if [ -f \"$PAPER_WORLD\" ]; then",
      "  python3 - \"$PAPER_WORLD\" <<'PY'",
      "import sys",
      "from pathlib import Path",
      "p = Path(sys.argv[1])",
      "lines = p.read_text(encoding='utf-8', errors='replace').splitlines()",
      "out = []",
      "in_anti_xray = False",
      "anti_indent = None",
      "for line in lines:",
      "    stripped = line.strip()",
      "    indent = len(line) - len(line.lstrip(' '))",
      "    if in_anti_xray and anti_indent is not None and stripped and not stripped.startswith('#') and indent <= anti_indent:",
      "        in_anti_xray = False",
      "    if stripped.startswith('anti-xray:') and not stripped.startswith('#'):",
      "        in_anti_xray = True",
      "        anti_indent = indent",
      perPlayer
        ? `    if stripped.startswith('per-player-mob-spawns:'):\n        out.append(f\"{' ' * indent}per-player-mob-spawns: ${perPlayer}\")\n        continue`
        : "    True",
      spawnRange
        ? `    if stripped.startswith('keep-spawn-loaded-range:'):\n        out.append(f\"{' ' * indent}keep-spawn-loaded-range: ${spawnRange}\")\n        continue`
        : "    True",
      antiXray
        ? `    if in_anti_xray and stripped.startswith('enabled:'):\n        out.append(f\"{' ' * indent}enabled: ${antiXray}\")\n        continue`
        : "    True",
      "    out.append(line)",
      "p.write_text('\\n'.join(out) + '\\n', encoding='utf-8')",
      "PY",
      "  PATCHED=1",
      "fi",
    );
  }

  if (geyser || bluemap || patchPaperWorld || patchPaperUsername) {
    lines.push(
      'if [ "${PATCHED:-0}" = 1 ]; then',
      '  chown -R "$LINUX_USER:$LINUX_USER" "$INSTALL_DIR/plugins" "$INSTALL_DIR/config" 2>/dev/null || chown -R "$LINUX_USER:$LINUX_USER" "$INSTALL_DIR"',
      "  systemctl restart minecraft",
      "fi",
    );
  }

  return lines.join("\n");
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("../../postfix-relay/lib/postfix-relay-configure.mjs").createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {Record<string, unknown>} opts.install
 * @param {ReturnType<typeof import("./deployments.mjs").mergeMinecraftSettings>} opts.minecraft
 * @param {{ skipUpgrade?: boolean }} [opts.flags]
 */
export async function installMinecraftInQemu(opts) {
  const { exec, log, install, minecraft } = opts;
  if (minecraft.eula !== true) {
    throw new Error("minecraft.eula must be true to start Paper (Mojang EULA)");
  }
  const skipUpgrade = opts.flags?.skipUpgrade === true;
  let paper = {
    version: minecraft.paperVersion,
    build: "pinned",
    name: "paper.jar",
    url: "",
  };
  if (!skipUpgrade) {
    paper = await resolvePaperDownload(minecraft.paperVersion);
  } else {
    errout.write(`[hdc] minecraft install: --skip-upgrade — keeping Paper jar; ensuring plugin jars if missing.\n`);
  }
  const pluginJars = await resolvePluginJars(minecraft);
  let mc = minecraft;
  if (mc.whitelist?.players?.length) {
    const players = await resolveWhitelistPlayers(mc.whitelist.players);
    mc = { ...mc, whitelist: { ...mc.whitelist, players } };
  }
  const inner = buildInstallShellScript({
    install,
    minecraft: mc,
    paper,
    pluginJars,
    flags: { skipJarDownload: skipUpgrade },
  });
  log.info(`${exec.label}: installing Paper Minecraft (plugins + Geyser/Floodgate) …`);
  const r = exec.run(inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return {
    ok: true,
    linux_user: resolveLinuxUser(install),
    paper_version: paper.version,
    paper_build: paper.build,
    java_port: minecraft.javaPort,
    bedrock_port: minecraft.bedrockPort,
    geyser: minecraft.geyser,
    floodgate: minecraft.floodgate,
    bluemap: minecraft.bluemap,
    bluemap_web_port: minecraft.bluemapWebPort,
    essentialsx: minecraft.essentialsx,
    worldedit: minecraft.worldedit,
    worldguard: minecraft.worldguard,
    vault: minecraft.vault,
    tree_feller: minecraft.treeFeller,
    chunky: minecraft.chunky,
    dead_chest: minecraft.deadChest,
    decent_holograms: minecraft.decentHolograms,
    drop_heads: minecraft.dropHeads,
    luckperms: minecraft.luckperms,
    protocollib: minecraft.protocollib,
    requests: minecraft.requests,
    signshop: minecraft.signshop,
    silk_spawners: minecraft.silkSpawners,
    vanish_no_packet: minecraft.vanishNoPacket,
    worldedit_sui: minecraft.worldeditSui,
    plugins_ensured: pluginJars.map((j) => j.dest),
    skipped_jar_download: skipUpgrade,
    message: skipUpgrade ? "config/unit re-applied; missing plugins ensured" : "installed",
  };
}
