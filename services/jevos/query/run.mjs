#!/usr/bin/env node
/**
 * Query jevos deployments (config summary + optional live systemd status via pct exec).
 *
 * Usage: hdc run service jevos query -- [--instance a] [--live]
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { resolvePveSshForHost } from "../../../infrastructure/proxmox/lib/proxmox-pve-ssh.mjs";
import { listJevosDeploymentSummaries, resolveJevosDeployments } from "../lib/deployments.mjs";
import { queryJevosInCt } from "../lib/jevos-install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/jevos/config.example.json";

async function main() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  const rel = loaded.ok && loaded.path ? relative(root, loaded.path).replace(/\\/g, "/") : CLUMP_CONFIG_EXAMPLE;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;
  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);
  let deployments = [];
  let configError = null;
  const liveResults = [];
  if (loaded.ok && loaded.data) {
    try {
      deployments = listJevosDeploymentSummaries(loaded.data);
      if (live) {
        for (const d of resolveJevosDeployments(loaded.data, flags)) {
          try {
            const ssh = resolvePveSshForHost(proxmoxRoot, d.proxmox.host_id);
            liveResults.push({ system_id: d.systemId, ok: true, ...queryJevosInCt(ssh.user, ssh.host, Number(d.proxmox.lxc.vmid)) });
          } catch (e) {
            liveResults.push({ system_id: d.systemId, ok: false, message: String(e?.message || e) });
          }
        }
      }
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }
  const ok = loaded.ok && !configError;
  const payload = {
    target,
    verb,
    ok,
    config_path: rel,
    deployments,
    live: live ? liveResults : undefined,
    config_error: configError,
    message: configError
      ? `Config error: ${configError}`
      : `${deployments.length} deployment(s). Deploy: hdc run service jevos deploy — live: hdc run service jevos query -- --live`,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: String(e?.message || e) }, null, 2)}\n`);
  process.exitCode = 1;
});
