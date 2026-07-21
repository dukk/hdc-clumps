#!/usr/bin/env node
/**
 * Query Home Assistant deployment status.
 *
 * Usage: hdc run service homeassistant query -- [--instance a | --system-id vm-homeassistant-a]
 *        hdc run service homeassistant query -- --live
 *        hdc run service homeassistant query -- --import --yes
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listHomeassistantDeploymentSummaries,
  normalizeHomeassistantConfig,
  resolveHomeassistantDeployments,
} from "hdc/package/deployments.mjs";
import { probeHomeAssistantHttp } from "hdc/package/query-status.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { locateGuest } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { importHomeassistantToConfig } from "../lib/ha-import.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/homeassistant/config.example.json";
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

async function main() {
  const rel = relative(root, ensurePackageConfig().path).replace(/\\/g, "/");
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  const cfg = loaded.ok && loaded.data ? loaded.data : null;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;
  const doImport = flagGet(flags, "import") !== undefined;
  const yes = flagGet(flags, "yes") !== undefined;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);
  if (doImport) {
    errout.write(
      `[hdc] ${target} ${verb}: import will write integrations/automations/scripts/scenes sidecars.\n`,
    );
  }

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;

  if (cfg) {
    try {
      const norm = normalizeHomeassistantConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listHomeassistantDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];
  /** @type {Record<string, unknown> | null} */
  let importResult = null;

  if (doImport) {
    if (!cfg || configError) {
      configError = configError ?? "config required for --import";
    } else if (!yes) {
      errout.write(`[hdc] ${target} ${verb}: import requires --yes (non-interactive).\n`);
      process.exitCode = 1;
      process.stdout.write(
        `${JSON.stringify({ ok: false, target, verb, message: "import requires --yes" }, null, 2)}\n`,
      );
      return;
    } else {
      try {
        const selected = resolveHomeassistantDeployments(cfg, flags);
        if (selected.length !== 1) {
          throw new Error(
            `import requires exactly one deployment (got ${selected.length}); pass --instance or --system-id`,
          );
        }
        const d = selected[0];
        errout.write(`[hdc] ${target} ${verb}: importing from ${d.systemId} …\n`);
        importResult = await importHomeassistantToConfig({
          clumpRoot,
          cfg,
          deployment: d,
          log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
        });
      } catch (e) {
        configError = String(/** @type {Error} */ (e).message || e);
      }
    }
  }

  if (live && cfg && !configError) {
    try {
      const selected = resolveHomeassistantDeployments(cfg, flags);
      errout.write(`[hdc] ${target} ${verb}: live status for ${selected.length} deployment(s) …\n`);
      for (const d of selected) {
        const hostId = d.proxmox.hostId;
        const vmid = d.proxmox.qemu.vmid;
        const ipHost = d.proxmox.qemu.ip.split("/")[0];
        try {
          const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
          const located = await locateGuest(
            auth.host.apiBase,
            auth.authorization,
            auth.rejectUnauthorized,
            vmid,
          );
          const http = await probeHomeAssistantHttp(ipHost);
          liveResults.push({
            system_id: d.systemId,
            ok: Boolean(located) && http.ok,
            vmid,
            node: located?.node ?? null,
            guest_name: located?.name ?? null,
            http,
          });
        } catch (e) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: String(/** @type {Error} */ (e).message || e),
          });
        }
      }
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  const payload = {
    ok: !configError,
    target,
    verb,
    stub: false,
    schema_version: schemaVersion,
    config_error: configError,
    deployments,
    live: live ? liveResults : undefined,
    import: importResult ?? undefined,
    generated_at: new Date().toISOString(),
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = configError ? 1 : 0;
}

main();
