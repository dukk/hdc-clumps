import { existsSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";

import { normalizeZoneName } from "../../cloudflare/lib/cloudflare-config.mjs";
import { resolveRepoFile } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";

/**
 * @typedef {object} ConfigWorkerRoute
 * @property {string} pattern
 * @property {string} zone_name
 */

/**
 * @typedef {object} ConfigWorkerSecret
 * @property {string} name
 * @property {string} vault_key
 */

/**
 * @typedef {object} ConfigWorker
 * @property {string} id
 * @property {boolean} managed
 * @property {string} project_dir
 * @property {string} script_name
 * @property {string | null} wrangler_env
 * @property {boolean} npm_install
 * @property {ConfigWorkerRoute[]} routes
 * @property {ConfigWorkerSecret[]} secrets
 */

/**
 * @typedef {object} ConfigPages
 * @property {string} id
 * @property {boolean} managed
 * @property {string} project_dir
 * @property {string} project_name
 * @property {string} deploy_dir
 * @property {string | null} build_command
 * @property {string | null} production_branch
 * @property {boolean} npm_install
 * @property {boolean} create_project
 */

/**
 * @typedef {object} NormalizedWorkersConfig
 * @property {number} schemaVersion
 * @property {string} apiBase
 * @property {string} accountId
 * @property {string} wranglerBinary
 * @property {{ mode: string; names: Set<string> }} zoneFilter
 * @property {ConfigWorker[]} workers
 * @property {Map<string, ConfigWorker>} workersById
 * @property {ConfigPages[]} pages
 * @property {Map<string, ConfigPages>} pagesById
 */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeCloudflareWorkersConfig(cfg) {
  const cw = isObject(cfg.cloudflare_workers) ? cfg.cloudflare_workers : {};
  const wrangler = isObject(cw.wrangler) ? cw.wrangler : {};

  const apiBase =
    typeof cw.api_base_url === "string" && cw.api_base_url.trim()
      ? cw.api_base_url.trim().replace(/\/$/, "")
      : "https://api.cloudflare.com/client/v4";

  let accountId = "";
  if (typeof cw.account_id === "string" && cw.account_id.trim()) {
    accountId = cw.account_id.trim();
  } else if (typeof env.HDC_CLOUDFLARE_ACCOUNT_ID === "string" && env.HDC_CLOUDFLARE_ACCOUNT_ID.trim()) {
    accountId = env.HDC_CLOUDFLARE_ACCOUNT_ID.trim();
  }

  if (!accountId) {
    throw new Error(
      "cloudflare_workers.account_id or HDC_CLOUDFLARE_ACCOUNT_ID is required for Workers and Pages API calls"
    );
  }

  const wranglerBinary =
    typeof wrangler.binary === "string" && wrangler.binary.trim() ? wrangler.binary.trim() : "wrangler";

  const zf = isObject(cw.zone_filter) ? cw.zone_filter : {};
  const mode = typeof zf.mode === "string" ? zf.mode : "all";
  const names = new Set(
    (Array.isArray(zf.names) ? zf.names : [])
      .map((n) => (typeof n === "string" ? normalizeZoneName(n) : ""))
      .filter(Boolean)
  );

  /** @type {ConfigWorker[]} */
  const workers = [];
  if (Array.isArray(cfg.workers)) {
    for (const raw of cfg.workers) {
      if (!isObject(raw)) continue;
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!id) continue;
      const projectDir = typeof raw.project_dir === "string" ? raw.project_dir.trim() : "";
      const scriptName =
        typeof raw.script_name === "string" && raw.script_name.trim()
          ? raw.script_name.trim()
          : id;

      /** @type {ConfigWorkerRoute[]} */
      const routes = [];
      if (Array.isArray(raw.routes)) {
        for (const r of raw.routes) {
          if (!isObject(r)) continue;
          const pattern = typeof r.pattern === "string" ? r.pattern.trim() : "";
          const zoneName =
            typeof r.zone_name === "string" ? normalizeZoneName(r.zone_name) : "";
          if (pattern && zoneName) routes.push({ pattern, zone_name: zoneName });
        }
      }

      /** @type {ConfigWorkerSecret[]} */
      const secrets = [];
      if (Array.isArray(raw.secrets)) {
        for (const s of raw.secrets) {
          if (!isObject(s)) continue;
          const name = typeof s.name === "string" ? s.name.trim() : "";
          const vaultKey = typeof s.vault_key === "string" ? s.vault_key.trim() : "";
          if (name && vaultKey) secrets.push({ name, vault_key: vaultKey });
        }
      }

      workers.push({
        id,
        managed: raw.managed !== false,
        project_dir: projectDir || `workers/${id}`,
        script_name: scriptName,
        wrangler_env:
          typeof raw.wrangler_env === "string" && raw.wrangler_env.trim()
            ? raw.wrangler_env.trim()
            : null,
        npm_install: raw.npm_install !== false,
        routes,
        secrets,
      });
    }
  }

  /** @type {ConfigPages[]} */
  const pages = [];
  if (Array.isArray(cfg.pages)) {
    for (const raw of cfg.pages) {
      if (!isObject(raw)) continue;
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!id) continue;
      const projectName =
        typeof raw.project_name === "string" && raw.project_name.trim()
          ? raw.project_name.trim()
          : id;
      pages.push({
        id,
        managed: raw.managed !== false,
        project_dir: typeof raw.project_dir === "string" && raw.project_dir.trim()
          ? raw.project_dir.trim()
          : `pages/${id}`,
        project_name: projectName,
        deploy_dir:
          typeof raw.deploy_dir === "string" && raw.deploy_dir.trim()
            ? raw.deploy_dir.trim()
            : "dist",
        build_command:
          typeof raw.build_command === "string" && raw.build_command.trim()
            ? raw.build_command.trim()
            : null,
        production_branch:
          typeof raw.production_branch === "string" && raw.production_branch.trim()
            ? raw.production_branch.trim()
            : null,
        npm_install: raw.npm_install !== false,
        create_project: raw.create_project !== false,
      });
    }
  }

  return {
    schemaVersion: typeof cfg.schema_version === "number" ? cfg.schema_version : 1,
    apiBase,
    accountId,
    wranglerBinary,
    zoneFilter: { mode, names },
    workers,
    workersById: new Map(workers.map((w) => [w.id, w])),
    pages,
    pagesById: new Map(pages.map((p) => [p.id, p])),
  };
}

/**
 * @param {string} zoneName
 * @param {{ mode: string; names: Set<string> }} zoneFilter
 */
export function zonePassesFilter(zoneName, zoneFilter) {
  const z = normalizeZoneName(zoneName);
  if (zoneFilter.mode === "include") return zoneFilter.names.has(z);
  if (zoneFilter.mode === "exclude") return !zoneFilter.names.has(z);
  return true;
}

/**
 * @param {ConfigWorker} worker
 * @param {string | null | undefined} filterId
 */
export function workerPassesFilter(worker, filterId) {
  if (!worker.managed) return false;
  if (filterId && worker.id !== filterId) return false;
  return true;
}

/**
 * @param {ConfigPages} page
 * @param {string | null | undefined} filterId
 */
export function pagesPassesFilter(page, filterId) {
  if (!page.managed) return false;
  if (filterId && page.id !== filterId) return false;
  return true;
}

/**
 * Resolve project_dir relative to the cloudflare-workers clump root (public then hdc-private).
 * @param {string} clumpRoot
 * @param {string} projectDirRel
 */
export function resolveWorkerProjectDir(clumpRoot, projectDirRel) {
  const rel = projectDirRel.replace(/\\/g, "/").replace(/^\.\//, "");
  const packageRel = `clumps/infrastructure/cloudflare-workers/${rel}`;
  const resolved = resolveRepoFile(repoRoot(), packageRel);
  if (resolved.found) return resolved.path;

  const fallback = join(clumpRoot, rel);
  if (existsSync(fallback)) return fallback;

  throw new Error(
    `Worker/Pages project_dir not found: ${projectDirRel} (looked for ${packageRel} and ${fallback})`
  );
}

/**
 * @param {ConfigWorkerRoute} route
 * @param {string} scriptName
 */
export function routeMatchKey(route, scriptName) {
  return `${route.zone_name}|${route.pattern}|${scriptName}`;
}

export const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/cloudflare-workers/config.example.json";
