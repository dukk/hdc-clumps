import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} filePath
 */
export function sha256File(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * @param {import('./slack-config.mjs').SlackConfigApp} app
 * @param {string} hdcRoot
 * @returns {string | null}
 */
export function resolveAppIconPath(app, hdcRoot) {
  const repoPath = app.icon?.repo_path?.trim();
  if (!repoPath) return null;
  const root = String(hdcRoot ?? "").trim();
  if (!root) throw new Error("hdc repo root is required to resolve icon.repo_path");
  const abs = join(root, repoPath.replace(/^[/\\]+/, ""));
  if (!existsSync(abs)) {
    throw new Error(`icon file not found: ${repoPath} (resolved ${abs})`);
  }
  return abs;
}

/**
 * @param {import('./slack-config.mjs').SlackConfigApp} app
 * @param {string} filePath
 */
export function iconNeedsUpdate(app, filePath) {
  const applied = app.icon?.applied_sha256?.trim().toLowerCase() ?? "";
  if (!applied) return true;
  return sha256File(filePath) !== applied;
}

/**
 * @param {ReturnType<import('./slack-api.mjs').createSlackManifestClient>} api
 * @param {import('./slack-config.mjs').SlackConfigApp} app
 * @param {string} appId
 * @param {string} filePath
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyAppIcon(api, app, appId, filePath, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});
  const repoPath = app.icon?.repo_path?.trim() || filePath;

  if (!iconNeedsUpdate(app, filePath)) {
    log(`icon ${app.id}: unchanged (${repoPath})`);
    return { ok: true, action: "unchanged", sha256: app.icon?.applied_sha256 ?? "" };
  }

  const sha256 = sha256File(filePath);
  if (dryRun) {
    log(`dry-run: would upload icon ${repoPath} for ${app.id}`);
    return { ok: true, action: "upload", dryRun: true, sha256 };
  }

  await api.setAppIcon(appId, filePath);
  log(`icon ${app.id}: uploaded ${repoPath}`);
  return { ok: true, action: "upload", sha256 };
}

/**
 * @param {import('./slack-config.mjs').SlackConfigApp} app
 * @param {string} hdcRoot
 * @returns {{ configured: boolean, drift: boolean, repo_path?: string, applied_sha256?: string, local_sha256?: string, error?: string }}
 */
export function collectIconState(app, hdcRoot) {
  if (!app.icon?.repo_path?.trim()) {
    return { configured: false, drift: false };
  }
  try {
    const filePath = resolveAppIconPath(app, hdcRoot);
    if (!filePath) return { configured: false, drift: false };
    const localSha256 = sha256File(filePath);
    const applied = app.icon.applied_sha256?.trim().toLowerCase() ?? "";
    return {
      configured: true,
      drift: !applied || localSha256 !== applied,
      repo_path: app.icon.repo_path,
      applied_sha256: applied || undefined,
      local_sha256: localSha256,
    };
  } catch (e) {
    return {
      configured: true,
      drift: true,
      repo_path: app.icon.repo_path,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Upload configured icons for managed apps and merge applied_sha256 into config apps[].
 *
 * @param {object} opts
 * @param {ReturnType<import('./slack-api.mjs').createSlackManifestClient>} opts.api
 * @param {import('./slack-config.mjs').SlackConfigApp[]} opts.apps
 * @param {string} opts.hdcRoot
 * @param {unknown[]} opts.configApps
 * @param {string} [opts.appIdOverride]
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} [opts.log]
 */
export async function syncConfiguredAppIcons(opts) {
  const log = opts.log ?? (() => {});
  /** @type {object[]} */
  const results = [];
  let configDirty = false;
  const nextApps = [...opts.configApps];

  for (const app of opts.apps) {
    if (!app.icon?.repo_path?.trim()) continue;
    const rawIdx = nextApps.findIndex((a) => a && typeof a === "object" && a.id === app.id);
    const rawApp = rawIdx >= 0 ? nextApps[rawIdx] : null;
    const rawMatch =
      rawApp && typeof rawApp === "object" && rawApp.match && typeof rawApp.match === "object"
        ? rawApp.match
        : null;
    const appId =
      opts.appIdOverride ||
      (typeof rawMatch?.app_id === "string" ? rawMatch.app_id.trim() : "") ||
      app.match.app_id;
    if (!appId) {
      results.push({ id: app.id, ok: false, action: "missing_app_id" });
      continue;
    }

    let filePath;
    try {
      filePath = resolveAppIconPath(app, opts.hdcRoot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`icon ${app.id}: ${msg}`);
      results.push({ id: app.id, ok: false, action: "resolve", error: msg });
      continue;
    }
    if (!filePath) continue;

    try {
      const applied = await applyAppIcon(opts.api, app, appId, filePath, {
        dryRun: opts.dryRun,
        log,
      });
      if (applied.ok && applied.sha256 && !opts.dryRun && applied.action === "upload") {
        const idx = nextApps.findIndex((a) => a && typeof a === "object" && a.id === app.id);
        if (idx >= 0) {
          const raw = nextApps[idx];
          const icon =
            raw && typeof raw === "object" && raw.icon && typeof raw.icon === "object"
              ? { ...raw.icon }
              : { repo_path: app.icon.repo_path };
          icon.applied_sha256 = applied.sha256;
          nextApps[idx] = { ...raw, icon };
          configDirty = true;
        }
      }
      results.push({ id: app.id, ...applied });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`icon ${app.id}: failed ${msg}`);
      results.push({ id: app.id, ok: false, action: "upload", error: msg });
    }
  }

  return { results, configDirty, nextApps };
}
