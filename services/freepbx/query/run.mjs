#!/usr/bin/env node
/**
 * Query FreePBX config summary. --live checks fwconsole, Asterisk, and the admin UI.
 *
 * Usage: hdc run service freepbx query -- [--instance a] [--live] [--disable-firewall]
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import {
  listFreepbxDeploymentSummaries,
  normalizeFreepbxConfig,
  resolveFreepbxDeployments,
} from "hdc/package/deployments.mjs";
import { disableFreepbxFirewall, FREEPBX_QUERY_SCRIPT } from "hdc/package/freepbx-guest.mjs";
import { sshBashStdin } from "hdc/package/ssh-stream.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/freepbx/config.example.json";
const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();

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
  const disableFirewall = flagGet(flags, "disable-firewall", "disable_firewall") !== undefined;
  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);

  /** @type {unknown[]} */
  let summaries = [];
  /** @type {string | null} */
  let configError = null;
  if (cfg) {
    try {
      normalizeFreepbxConfig(cfg);
      summaries = listFreepbxDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  if (disableFirewall && cfg && !configError) {
    const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
    for (const d of resolveFreepbxDeployments(cfg, flags)) {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const q = isObject(px.qemu) ? px.qemu : {};
      const hostId = typeof px.host_id === "string" ? px.host_id : "";
      const vmid = Number(q.vmid);
      await disableFreepbxFirewall({
        proxmoxRoot,
        hostId,
        node: hostId,
        vmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];
  if (live && cfg && !configError) {
    for (const d of resolveFreepbxDeployments(cfg, flags)) {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const q = isObject(px.qemu) ? px.qemu : {};
      const sshCfg = isObject(d.configure) && isObject(d.configure.ssh) ? d.configure.ssh : {};
      const ip = typeof q.ip === "string" ? q.ip.split("/")[0] : "";
      const host = typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip;
      const user = resolveGuestSshUser(sshCfg.user);
      errout.write(`[hdc] ${target} ${verb}: live ${user}@${host} …\n`);
      const r = sshBashStdin({
        user,
        host,
        script: FREEPBX_QUERY_SCRIPT,
        sudo: true,
        timeoutMs: 120_000,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      liveResults.push({
        system_id: d.systemId,
        host,
        ok: r.status === 0,
        preview: r.stdout.trim().slice(-2000),
      });
    }
  }

  const payload = {
    ok: !configError && liveResults.every((r) => r.ok !== false),
    target,
    verb,
    config_loaded: loaded.ok,
    config_error: configError,
    deployments: summaries,
    live: liveResults,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = payload.ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).message || e}\n`);
  process.exitCode = 1;
});
