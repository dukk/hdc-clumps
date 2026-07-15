import { repoRoot } from "hdc/cli/paths.mjs";
import { readResolvedPackageConfigJson } from "hdc/cli/lib/json-config-preprocess.mjs";
import {
  assertJsonObject,
  missingRepoFileError,
  resolveRepoFile,
} from "hdc/cli/lib/private-repo.mjs";
import {
  loadClumpConfigFromClumpRoot,
  tryLoadClumpConfigFromClumpRoot,
} from "hdc/cli/lib/clump-config.mjs";

const PROXMOX_CONFIG_REL = "clumps/infrastructure/proxmox/config.json";

/**
 * @param {string} [publicRoot]
 */
export function proxmoxConfigRel(publicRoot = repoRoot()) {
  return PROXMOX_CONFIG_REL;
}

/**
 * @param {string} clumpRoot clumps/infrastructure/proxmox
 * @param {{ publicRoot?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void }} [opts]
 */
export function loadProxmoxPackageConfig(clumpRoot, opts = {}) {
  const publicRoot = opts.publicRoot ?? repoRoot();
  return loadClumpConfigFromClumpRoot(clumpRoot, {
    publicRoot,
    env: opts.env,
    exampleRel: PROXMOX_CONFIG_REL.replace(/config\.json$/, "config.example.json"),
    log: opts.log,
  });
}

/**
 * @param {string} clumpRoot
 * @param {{ publicRoot?: string; env?: NodeJS.ProcessEnv }} [opts]
 */
export function tryLoadProxmoxPackageConfig(clumpRoot, opts = {}) {
  const publicRoot = opts.publicRoot ?? repoRoot();
  return tryLoadClumpConfigFromClumpRoot(clumpRoot, { publicRoot, env: opts.env });
}

/**
 * @param {string} publicRoot
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveProxmoxConfigFile(publicRoot, env = process.env) {
  return resolveRepoFile(publicRoot, PROXMOX_CONFIG_REL, env);
}

/**
 * Resolved absolute path (public or private) when config exists.
 * @param {string} clumpRoot
 * @param {{ publicRoot?: string; env?: NodeJS.ProcessEnv }} [opts]
 */
export function proxmoxConfigPath(clumpRoot, opts = {}) {
  const publicRoot = opts.publicRoot ?? repoRoot();
  const resolved = resolveProxmoxConfigFile(publicRoot, opts.env);
  return resolved.found ? resolved.path : resolved.publicPath;
}

/**
 * Load config for maintain modules; return null after warn when missing/invalid.
 * @param {string} clumpRoot
 * @param {(line: string) => void} warn
 * @param {string} skipLabel e.g. "API token maintain"
 * @param {{ missingOk?: boolean }} [opts]
 */
/**
 * @param {string} [publicRoot]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadProxmoxConfigFromRepo(publicRoot = repoRoot(), env = process.env) {
  const resolved = resolveProxmoxConfigFile(publicRoot, env);
  if (!resolved.found) {
    throw missingRepoFileError(resolved, {
      exampleRel: "clumps/infrastructure/proxmox/config.example.json",
    });
  }
  return {
    data: assertJsonObject(readResolvedPackageConfigJson(resolved, { publicRoot, env })),
    path: resolved.path,
    resolved,
  };
}

export function loadProxmoxMaintainConfig(clumpRoot, warn, skipLabel, opts = {}) {
  try {
    return loadProxmoxPackageConfig(clumpRoot);
  } catch (e) {
    const msg = /** @type {Error} */ (e).message;
    warn(`${skipLabel}: ${msg.includes("Missing") ? "missing config — skip." : msg}`);
    return null;
  }
}
