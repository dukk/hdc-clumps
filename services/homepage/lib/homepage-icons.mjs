import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { resolveRepoFilePath } from "hdc/cli/lib/private-repo.mjs";

const ICONS_REL_DIR = "homepage/icons";

/**
 * @param {string} packageRoot
 * @param {string} relPath
 */
function packageRelToRepoRel(packageRoot, relPath) {
  const root = repoRoot();
  const trimmed = typeof relPath === "string" ? relPath.trim() : "";
  if (!trimmed) {
    throw new Error("icon path is required");
  }
  const abs = join(packageRoot, trimmed);
  return relative(root, abs).replace(/\\/g, "/");
}

/**
 * @param {string} packageRoot
 * @returns {{ name: string; b64: string; source: string }[]}
 */
export function loadHomepageIcons(packageRoot) {
  const root = repoRoot();
  const iconsRepoRel = packageRelToRepoRel(packageRoot, ICONS_REL_DIR);
  const resolved = resolveRepoFilePath(root, iconsRepoRel);
  if (!resolved.found) {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(resolved.path, { withFileTypes: true });
  } catch {
    return [];
  }

  /** @type {{ name: string; b64: string; source: string }[]} */
  const icons = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!/\.png$/i.test(name)) continue;
    const filePath = join(resolved.path, name);
    const data = readFileSync(filePath);
    icons.push({
      name,
      b64: data.toString("base64"),
      source: resolved.source,
    });
  }

  icons.sort((a, b) => a.name.localeCompare(b.name));
  if (icons.length > 0) {
    errout.write(
      `[hdc] homepage: loading ${icons.length} icon(s) from ${resolved.rel} (${resolved.source}): ${icons.map((i) => i.name).join(", ")}\n`,
    );
  }
  return icons;
}

/**
 * @param {string} composeDirPath
 * @param {{ name: string; b64: string }[]} icons
 * @returns {string[]}
 */
/**
 * @param {string} composeDirPath
 * @param {string} filename
 * @param {string} b64
 */
function writeIconFileHerdoc(composeDirPath, filename, b64) {
  const remotePath = `${composeDirPath}/icons/${filename}`.replace(/'/g, `'\\''`);
  const marker = `HDCICON${filename.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
  return [
    `cat > '${remotePath}.b64' <<'${marker}'`,
    b64,
    marker,
    `base64 -d '${remotePath}.b64' > '${remotePath}'`,
    `rm -f '${remotePath}.b64'`,
  ];
}

export function buildIconWriteScriptLines(composeDirPath, icons) {
  if (icons.length === 0) return [];
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  /** @type {string[]} */
  const lines = [`mkdir -p '${dir}/icons'`];
  for (const icon of icons) {
    lines.push(...writeIconFileHerdoc(composeDirPath, icon.name, icon.b64));
  }
  return lines;
}
