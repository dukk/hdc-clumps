#!/usr/bin/env node
/**
 * Query MeshCentral deployments (config summary + optional live CT / device API status).
 *
 * Usage: hdc run service meshcentral query -- [--instance a]
 *        hdc run service meshcentral query -- --live
 *        hdc run service meshcentral query -- --live --device lan-1
 *        hdc run service meshcentral query -- --live --hardware --device lan-1
 *        hdc run service meshcentral query -- --import --yes
 *        hdc run service meshcentral query -- --import --yes --skip-hardware
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listMeshcentralDeploymentSummaries,
  normalizeMeshcentralConfig,
  resolveMeshcentralDeployments,
} from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "hdc/package/meshcentral-install.mjs";
import { queryMeshcentralInCt } from "hdc/package/query-status.mjs";
import { parseDeviceSelectors, resolveDevices } from "hdc/package/meshcentral-devices.mjs";
import { applyDevicesToConfig, mergeDevicesFromLive } from "hdc/package/meshcentral-inventory.mjs";
import { collectDisk, collectHardware, collectHardwareFromSysinfo } from "hdc/package/meshcentral-ops.mjs";
import {
  loadClientHostsFromConfigs,
  upsertSystemSidecarsFromDevices,
} from "hdc/package/meshcentral-system-inventory.mjs";
import {
  listNormalizedDevices,
  meshcentralFromDeployments,
  openMeshcentralSession,
} from "hdc/package/meshcentral-session.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/meshcentral/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string; resolved?: import("hdc/cli/lib/private-repo.mjs").ResolvedRepoFile } | null} */
let _pkgConfig = null;

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function loadCfg() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  if (loaded.ok && loaded.data) {
    _pkgConfig = { data: loaded.data, path: loaded.path, source: loaded.source };
  }
  return loaded;
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {string[]} argv
 */
async function queryDevicesApi(cfg, flags, argv) {
  const log = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
  let deployments;
  try {
    deployments = resolveMeshcentralDeployments(cfg, flags);
  } catch (e) {
    return { ok: false, message: String(/** @type {Error} */ (e).message || e) };
  }
  const meshcentral = meshcentralFromDeployments(deployments);
  const vault = createPackageVaultAccess();
  await vault.unlock({});
  const session = await openMeshcentralSession({ vault, meshcentral, log });
  try {
    const { live, configDevices } = await listNormalizedDevices(session.client, meshcentral);
    const selectors = parseDeviceSelectors(flags, argv);
    /** @type {Record<string, unknown>[]} */
    let devices = live.map((d) => ({ ...d }));

    if (selectors.length) {
      const resolved = resolveDevices({ liveDevices: live, configDevices, selectors });
      if (!resolved.ok) {
        return { ok: false, message: resolved.message, devices: live };
      }
      const wantHardware = flagGet(flags, "hardware") !== undefined;
      /** @type {Record<string, unknown>[]} */
      const detailed = [];
      for (const d of resolved.devices) {
        /** @type {Record<string, unknown>} */
        const row = { ...d };
        if (d.online && d.node_id) {
          if (wantHardware) {
            log(`collecting hardware for ${d.id || d.name} …`);
            try {
              row.hardware = await collectHardware(session.client, d, { log });
            } catch (e) {
              row.hardware = {
                ok: false,
                message: String(/** @type {Error} */ (e).message || e),
              };
            }
          } else {
            log(`collecting disk for ${d.id || d.name} …`);
            try {
              row.disk = await collectDisk(session.client, d, { log });
            } catch (e) {
              row.disk = {
                ok: false,
                message: String(/** @type {Error} */ (e).message || e),
              };
            }
          }
        } else if (wantHardware && d.node_id) {
          log(`collecting hardware for ${d.id || d.name} from MeshCentral sysinfo (offline) …`);
          try {
            row.hardware = await collectHardwareFromSysinfo(session.client, d, { log });
          } catch (e) {
            row.hardware = {
              ok: false,
              message: String(/** @type {Error} */ (e).message || e),
            };
          }
        } else if (wantHardware) {
          row.hardware = { ok: false, message: "device offline" };
        } else {
          row.disk = { ok: false, message: "device offline" };
        }
        detailed.push(row);
      }
      devices = detailed;
    }

    let imported = null;
    const doImport = flagGet(flags, "import") !== undefined;
    const yes = flagGet(flags, "yes") !== undefined;
    const skipHardware = flagGet(flags, "skip-hardware") !== undefined;
    if (doImport) {
      if (!yes) {
        return {
          ok: false,
          message: "query --import requires --yes",
          devices: live,
          api_url: session.url,
        };
      }
      const clientHosts = loadClientHostsFromConfigs(root);
      log(`loaded ${clientHosts.length} client host(s) for id matching`);
      const merged = mergeDevicesFromLive(meshcentral, live, { clientHosts });
      const nextCfg = applyDevicesToConfig(cfg, merged);
      // Force fresh load so we have ResolvedRepoFile for write.
      _pkgConfig = null;
      const loaded = ensurePackageConfig();
      if (!loaded.resolved) {
        throw new Error("config resolved path missing; cannot write devices[]");
      }
      writeResolvedRepoJson(loaded.resolved, nextCfg);
      log(`imported ${merged.length} device(s) into config devices[]`);

      /** @type {Map<string, { ok: boolean; hardware?: Record<string, unknown>[]; mac?: string | null; message?: string }>} */
      const hardwareById = new Map();
      if (!skipHardware) {
        /** @type {Map<string, Record<string, unknown>>} */
        const liveByNodeId = new Map();
        for (const d of live) {
          if (typeof d.node_id === "string" && d.node_id) liveByNodeId.set(d.node_id, d);
        }
        /** @type {Set<string> | null} */
        let hardwareIdFilter = null;
        if (selectors.length) {
          const resolved = resolveDevices({ liveDevices: live, configDevices: merged, selectors });
          if (resolved.ok) {
            hardwareIdFilter = new Set(
              resolved.devices
                .map((d) => (typeof d.id === "string" ? d.id : ""))
                .filter(Boolean),
            );
            log(`hardware collect limited to --device: ${[...hardwareIdFilter].join(", ")}`);
          }
        }
        for (const dev of merged) {
          const id = typeof dev.id === "string" ? dev.id : "";
          if (hardwareIdFilter && !hardwareIdFilter.has(id)) continue;
          const nodeId = typeof dev.node_id === "string" ? dev.node_id : "";
          const liveRow = nodeId ? liveByNodeId.get(nodeId) : null;
          if (!id || !nodeId) {
            if (id) {
              hardwareById.set(id, { ok: false, message: "missing node_id" });
            }
            continue;
          }
          const mergedDev = { ...dev, ...(liveRow || {}), node_id: nodeId };
          if (liveRow?.online) {
            log(`collecting hardware for ${id} …`);
            /** @type {{ ok: boolean; hardware?: Record<string, unknown>[]; mac?: string | null; message?: string }} */
            let hw = { ok: false, message: "not collected" };
            try {
              hw = await collectHardware(session.client, mergedDev, { log });
              if (!hw.ok) {
                log(`hardware collect failed for ${id}: ${hw.message || "unknown error"}`);
              }
            } catch (e) {
              const msg = String(/** @type {Error} */ (e).message || e);
              log(`hardware collect error for ${id}: ${msg}`);
              hw = { ok: false, message: msg };
            }
            if (!hw.ok) {
              log(`falling back to MeshCentral sysinfo for ${id} …`);
              try {
                const sysHw = await collectHardwareFromSysinfo(session.client, mergedDev, { log });
                if (sysHw.ok) {
                  hw = sysHw;
                } else {
                  log(`sysinfo hardware failed for ${id}: ${sysHw.message || "unknown error"}`);
                  if (!hw.message) hw = sysHw;
                }
              } catch (e) {
                const msg = String(/** @type {Error} */ (e).message || e);
                log(`sysinfo hardware error for ${id}: ${msg}`);
              }
            }
            hardwareById.set(id, hw);
            continue;
          }
          // Offline: use MeshCentral server-stored sysinfo (no agent runcommands).
          log(`collecting hardware for ${id} from MeshCentral sysinfo (offline) …`);
          try {
            const hw = await collectHardwareFromSysinfo(session.client, mergedDev, { log });
            hardwareById.set(id, hw);
            if (!hw.ok) {
              log(`sysinfo hardware failed for ${id}: ${hw.message || "unknown error"}`);
            }
          } catch (e) {
            const msg = String(/** @type {Error} */ (e).message || e);
            log(`sysinfo hardware error for ${id}: ${msg}`);
            hardwareById.set(id, { ok: false, message: msg });
          }
        }
      } else {
        log("skipping hardware collect (--skip-hardware)");
      }

      const systems = upsertSystemSidecarsFromDevices({
        publicRoot: root,
        mergedDevices: merged,
        liveDevices: live,
        hardwareById,
        log,
      });
      log(`upserted ${systems.written.length} system sidecar(s)`);

      imported = {
        count: merged.length,
        devices: merged,
        systems: systems.written,
        hardware_skipped: skipHardware,
      };
      _pkgConfig = {
        data: nextCfg,
        path: loaded.path,
        source: loaded.source,
        resolved: loaded.resolved,
      };
    }

    return {
      ok: true,
      api_url: session.url,
      device_count: live.length,
      devices,
      imported,
    };
  } finally {
    await session.client.close();
  }
}

async function main() {
  let loaded = loadCfg();
  let cfg = loaded.ok && isObject(loaded.data) ? loaded.data : null;
  let rel =
    loaded.ok && loaded.path
      ? relative(root, loaded.path).replace(/\\/g, "/")
      : CLUMP_CONFIG_EXAMPLE;

  if (!cfg && loaded.missing) {
    const examplePath = join(root, CLUMP_CONFIG_EXAMPLE);
    try {
      const raw = JSON.parse(readFileSync(examplePath, "utf8"));
      if (isObject(raw)) {
        cfg = raw;
        rel = CLUMP_CONFIG_EXAMPLE;
        loaded = { ...loaded, ok: true, missing: false };
        errout.write(`[hdc] ${target} ${verb}: using ${CLUMP_CONFIG_EXAMPLE} (no config.json yet).\n`);
      }
    } catch {
      /* fall through */
    }
  }

  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const live = flagGet(flags, "live") !== undefined;
  const doImport = flagGet(flags, "import") !== undefined;
  const deviceSelectors = parseDeviceSelectors(flags, argv);
  const wantApi = live || doImport || deviceSelectors.length > 0;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;

  if (cfg) {
    try {
      const norm = normalizeMeshcentralConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listMeshcentralDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];
  /** @type {Record<string, unknown> | null} */
  let apiDevices = null;

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveMeshcentralDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
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
          const status = await queryMeshcentralInCt(
            pveSsh.user,
            pveSsh.host,
            vmid,
            d.meshcentral,
            d.install,
          );
          liveResults.push({ system_id: d.systemId, ok: true, ...status });
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

  if (wantApi && cfg && !configError) {
    errout.write(`[hdc] ${target} ${verb}: querying MeshCentral device API …\n`);
    try {
      apiDevices = await queryDevicesApi(cfg, flags, argv);
      if (apiDevices && apiDevices.ok === false) {
        configError = typeof apiDevices.message === "string" ? apiDevices.message : "device API failed";
      }
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
      apiDevices = { ok: false, message: configError };
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
    live,
    live_results: live ? liveResults : undefined,
    devices: apiDevices?.devices,
    device_api: apiDevices
      ? {
          ok: apiDevices.ok,
          api_url: apiDevices.api_url,
          device_count: apiDevices.device_count,
          imported: apiDevices.imported,
          message: apiDevices.message,
        }
      : undefined,
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
