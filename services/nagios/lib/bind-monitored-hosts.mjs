import { readResolvedPackageConfigJson } from "hdc/cli/lib/json-config-preprocess.mjs";
import { resolveRepoFilePath } from "hdc/cli/lib/private-repo.mjs";

import { collectForwardARecords } from "../../bind/lib/bind-zones.mjs";
import { normalizeBindConfig } from "../../bind/lib/deployments.mjs";
import { buildNagiosBundleFromBind } from "./generate.mjs";

/**
 * @param {import("../../bind/lib/deployments.mjs").BindZoneDefinition[]} zones
 * @returns {Record<string, Record<string, unknown>>}
 */
export function zonesToMap(zones) {
  /** @type {Record<string, Record<string, unknown>>} */
  const map = {};
  for (const z of zones) {
    map[z.id] = {
      zone_type: z.zone_type,
      records: z.records,
      subnet: z.subnet,
    };
  }
  return map;
}

/**
 * @param {string} repoRoot
 * @param {string} bindConfigPath repo-relative or absolute
 */
export function resolveBindConfigPath(repoRoot, bindConfigPath) {
  const raw = typeof bindConfigPath === "string" ? bindConfigPath.trim() : "";
  if (!raw) {
    throw new Error("nagios config: bind_config_path is required");
  }
  const resolved = resolveRepoFilePath(repoRoot, raw);
  if (!resolved.found) {
    throw new Error(`nagios config: BIND config not found at ${resolved.rel} (checked hdc and hdc-private)`);
  }
  return resolved.path;
}

/**
 * Load forward-zone A records from a BIND clump config file.
 * @param {string} repoRoot
 * @param {string} bindConfigPath
 * @returns {{ bindPath: string; records: ReturnType<typeof collectForwardARecords> }}
 */
export function loadBindForwardARecords(repoRoot, bindConfigPath) {
  const resolved = resolveRepoFilePath(repoRoot, bindConfigPath);
  const bindPath = resolveBindConfigPath(repoRoot, bindConfigPath);
  const raw = readResolvedPackageConfigJson(resolved, { publicRoot: repoRoot });
  const { zones } = normalizeBindConfig(raw);
  const zoneMap = zonesToMap(zones);
  const records = collectForwardARecords(zoneMap);
  return { bindPath, records };
}

/**
 * Dedupe by FQDN (first wins).
 * @param {ReturnType<typeof collectForwardARecords>} records
 */
export function dedupeBindRecordsByFqdn(records) {
  const seen = new Set();
  /** @type {typeof records} */
  const out = [];
  for (const r of records) {
    const key = r.fqdn.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * @param {string} repoRoot
 * @param {string} bindConfigPath
 * @param {{ adminEmail?: string }} [notifications]
 */
export function loadNagiosBindBundle(repoRoot, bindConfigPath, notifications) {
  const { bindPath, records } = loadBindForwardARecords(repoRoot, bindConfigPath);
  const deduped = dedupeBindRecordsByFqdn(records);
  const bundle = buildNagiosBundleFromBind(deduped, {
    adminEmail: notifications?.adminEmail,
  });
  return { bindPath, bindRecordCount: deduped.length, ...bundle };
}
