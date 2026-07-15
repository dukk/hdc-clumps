import { readResolvedPackageConfigJson } from "hdc/cli/lib/json-config-preprocess.mjs";
import { resolveRepoFile } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} relPath
 */
export function loadNginxWafConfig(relPath) {
  const resolved = resolveRepoFile(repoRoot(), relPath);
  if (!resolved.found) {
    throw new Error(`nginx-waf config not found: ${relPath} (checked public and hdc-private)`);
  }
  const raw = readResolvedPackageConfigJson(resolved);
  if (!isObject(raw)) throw new Error(`nginx-waf config is not an object: ${relPath}`);
  return raw;
}

/**
 * @param {import('./discord-config.mjs').ConfigApplication['derive_from']} deriveFrom
 */
export function deriveRedirectUrisFromNginxWaf(deriveFrom) {
  if (!deriveFrom) {
    return { redirect_uris: [], hostname: null };
  }
  const cfg = loadNginxWafConfig(deriveFrom.nginx_waf_config_path);
  /** @type {Record<string, unknown>[]} */
  const siteLists = [];
  if (Array.isArray(cfg.deployment_groups)) {
    for (const group of cfg.deployment_groups) {
      if (isObject(group) && Array.isArray(group.sites)) {
        siteLists.push(...group.sites.filter(isObject));
      }
    }
  }
  if (Array.isArray(cfg.sites)) {
    siteLists.push(...cfg.sites.filter(isObject));
  }
  /** @type {Record<string, unknown> | null} */
  let site = null;
  for (const s of siteLists) {
    if (typeof s.id === "string" && s.id.trim() === deriveFrom.site_id) {
      site = s;
      break;
    }
  }
  if (!site) {
    throw new Error(
      `nginx-waf site not found: ${deriveFrom.site_id} in ${deriveFrom.nginx_waf_config_path}`
    );
  }
  const names = Array.isArray(site.host_names)
    ? site.host_names.map((n) => String(n).trim()).filter(Boolean)
    : Array.isArray(site.server_names)
      ? site.server_names.map((n) => String(n).trim()).filter(Boolean)
      : [];
  if (!names.length) {
    throw new Error(
      `nginx-waf site ${deriveFrom.site_id} has no host_names in ${deriveFrom.nginx_waf_config_path}`
    );
  }
  return buildDerivedRedirectUris(names[0], deriveFrom.callback_path);
}

/**
 * @param {string} hostname
 * @param {string} callbackPath
 */
export function buildDerivedRedirectUris(hostname, callbackPath) {
  const host = String(hostname).trim().replace(/\.$/, "");
  const path = callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`;
  const origin = `https://${host}`;
  return {
    redirect_uris: [`${origin}${path}`],
    hostname: host,
  };
}
