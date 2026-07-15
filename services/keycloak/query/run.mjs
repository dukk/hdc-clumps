#!/usr/bin/env node
/**
 * Query Keycloak deployments.
 *
 * Usage: hdc run service keycloak query -- [--instance a]
 *        hdc run service keycloak query -- --live
 *        hdc run service keycloak query -- --live [--realm <id>]
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listKeycloakDeploymentSummaries,
  normalizeKeycloakConfig,
  resolveKeycloakDeployments,
} from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "hdc/package/keycloak-install.mjs";
import { normalizeRealmList, queryKeycloakRealmDrift } from "hdc/package/keycloak-realms.mjs";
import { queryKeycloakInCt } from "hdc/package/query-status.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { createKeycloakVaultAccess } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/keycloak/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

function loadCfg() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  if (loaded.ok && loaded.data) {
    _pkgConfig = { data: loaded.data, path: loaded.path, source: loaded.source };
  }
  return loaded;
}

async function main() {
  const rel = relative(root, ensurePackageConfig().path).replace(/\\/g, "/");
  const loaded = loadCfg();
  const cfg = loaded.ok && isObject(loaded.data) ? loaded.data : null;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;
  const realmFilterRaw = flagGet(flags, "realm");
  const realmFilter =
    typeof realmFilterRaw === "string" && realmFilterRaw.trim() ? realmFilterRaw.trim() : undefined;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;
  /** @type {unknown[]} */
  let configuredRealms = [];

  if (cfg) {
    try {
      const norm = normalizeKeycloakConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listKeycloakDeploymentSummaries(cfg);
      const defaults = isObject(cfg.defaults) ? cfg.defaults : {};
      const kcDefaults = isObject(defaults.keycloak) ? defaults.keycloak : {};
      configuredRealms = normalizeRealmList(kcDefaults).map((r) => ({
        id: r.id,
        realm: r.realm,
        user_count: r.users.length,
      }));
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];
  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveKeycloakDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
      const vault = createKeycloakVaultAccess();
      await vault.unlock({});
      for (const d of selected) {
        const px = isObject(d.proxmox) ? d.proxmox : {};
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        const lxc = isObject(px.lxc) ? px.lxc : {};
        const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
        if (!hostId || !Number.isFinite(vmid)) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: "missing host_id or vmid",
          });
          continue;
        }
        errout.write(`[hdc] ${target} ${verb}: live query ${d.systemId} vmid ${vmid} …\n`);
        try {
          const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
          const status = await queryKeycloakInCt(
            pveSsh.user,
            pveSsh.host,
            vmid,
            d.keycloak,
            d.install,
            lxc,
          );
          /** @type {Record<string, unknown> | null} */
          let realmDrift = null;
          try {
            realmDrift = await queryKeycloakRealmDrift(
              isObject(d.keycloak) ? d.keycloak : {},
              vault,
              {
                ctIp: typeof status.ct_ip === "string" ? status.ct_ip : null,
                realmFilter,
                log: (line) => errout.write(`[hdc] ${target} ${verb}: ${d.systemId}: ${line}\n`),
              },
            );
          } catch (e) {
            realmDrift = {
              ok: false,
              message: String(/** @type {Error} */ (e).message || e),
            };
          }
          liveResults.push({
            system_id: d.systemId,
            ok: true,
            ...status,
            realms: realmDrift,
          });
        } catch (e) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: String(/** @type {Error} */ (e).message || e),
          });
        }
      }
    }
  }

  const payload = {
    ok: !configError && (loaded.ok || loaded.missing),
    target,
    verb,
    config_path: rel,
    config_loaded: loaded.ok,
    config_missing: loaded.missing === true,
    schema_version: schemaVersion,
    config_error: configError,
    deployments,
    configured_realms: configuredRealms,
    live,
    live_results: live ? liveResults : undefined,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = configError ? 1 : 0;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
