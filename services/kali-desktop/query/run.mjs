#!/usr/bin/env node
/**
 * Query kali-desktop deployments (config summary + optional live status).
 *
 * Usage: hdc run service kali-desktop query -- [--instance a] [--live]
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listKaliDesktopDeploymentSummaries,
  normalizeKaliDesktopConfig,
  resolveKaliDesktopDeployments,
} from "hdc/package/deployments.mjs";
import { queryKaliDesktopLive } from "hdc/package/query-status.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { fetchClusterVmResources } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { locateGuestByName } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { mergedProxmoxBlock } from "hdc/package/deployments.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/kali-desktop/config.example.json";
const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  const rel = relative(root, ensurePackageConfig().path).replace(/\\/g, "/");
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  const cfg = loaded.ok && isObject(loaded.data) ? loaded.data : null;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);

  /** @type {unknown[]} */
  let summaries = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;

  if (cfg) {
    try {
      const norm = normalizeKaliDesktopConfig(cfg);
      schemaVersion = norm.schemaVersion;
      summaries = listKaliDesktopDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];
  if (live && cfg && !configError) {
    const norm = normalizeKaliDesktopConfig(cfg);
    const selected = resolveKaliDesktopDeployments(cfg, flags);
    for (const d of selected) {
      const px = mergedProxmoxBlock(norm.defaults, d.proxmox);
      const hostId = typeof px.host_id === "string" ? px.host_id : "";
      const q = isObject(px.qemu) ? px.qemu : {};
      const guestName =
        d.hostname ||
        d.systemId.replace(/^vm-/, "").slice(0, 63);
      let vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
      const sshCfg = isObject(d.configure) && isObject(d.configure.ssh) ? d.configure.ssh : {};
      if (!hostId) {
        liveResults.push({ system_id: d.systemId, ok: false, message: "proxmox.host_id required for --live" });
        continue;
      }
      if (!Number.isFinite(vmid) || vmid <= 0) {
        const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
        const resources = await fetchClusterVmResources(
          auth.host.apiBase,
          auth.authorization,
          auth.rejectUnauthorized,
        );
        const byName = locateGuestByName(resources, guestName);
        if (!byName) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: `guest ${guestName} not found`,
          });
          continue;
        }
        vmid = byName.vmid;
      }
      try {
        const lr = await queryKaliDesktopLive({
          proxmoxRoot,
          hostId,
          vmid,
          sshUser: typeof sshCfg.user === "string" ? sshCfg.user : "kali",
          sshHost: typeof sshCfg.host === "string" ? sshCfg.host : undefined,
        });
        liveResults.push({ system_id: d.systemId, ...lr });
      } catch (e) {
        liveResults.push({
          system_id: d.systemId,
          ok: false,
          message: String(/** @type {Error} */ (e).message || e),
        });
      }
    }
  }

  const payload = {
    ok: !configError,
    target,
    verb,
    config_path: rel,
    config_loaded: Boolean(cfg),
    schema_version: schemaVersion,
    config_error: configError,
    deployments: summaries,
    live: live ? liveResults : undefined,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = configError ? 1 : 0;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${e.message || e}\n`);
  process.exitCode = 1;
});
