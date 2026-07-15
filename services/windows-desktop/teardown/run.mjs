#!/usr/bin/env node
/**
 * Teardown Windows desktop QEMU VM on Proxmox.
 *
 * Usage: hdc run service windows-desktop teardown -- [--instance a] [--dry-run] [--yes]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { locateGuest, stopAndDestroyQemu } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";

import { resolveWindowsDesktopDeployments } from "hdc/package/deployments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  const dryRun = flagGet(flags, "dry-run") !== undefined;
  const yes = flagGet(flags, "yes") !== undefined;
  const deps = createNodeCliDeps();
  const cfg = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: "clumps/services/windows-desktop/config.example.json",
  }).data;

  if (!yes && !dryRun) {
    errout.write(`[hdc] ${target} ${verb}: re-run with --yes to destroy VM(s), or --dry-run to preview.\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "missing --yes" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  for (const d of resolveWindowsDesktopDeployments(cfg, flags)) {
    const vmid = Number(d.proxmox.qemu.vmid);
    const hostId = d.proxmox.hostId;
    if (!Number.isFinite(vmid) || vmid <= 0) {
      results.push({ ok: false, system_id: d.systemId, message: "vmid required" });
      ok = false;
      continue;
    }

    if (dryRun) {
      errout.write(`[hdc] ${target} ${verb}: dry-run would destroy ${d.systemId} vmid ${vmid} on ${hostId}.\n`);
      results.push({ ok: true, system_id: d.systemId, dry_run: true, vmid });
      continue;
    }

    try {
      const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
      const located = await locateGuest(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
        vmid,
      );
      if (!located) {
        results.push({ ok: true, system_id: d.systemId, message: "vm not found", vmid });
        continue;
      }
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      errout.write(
        `[hdc] ${target} ${verb}: destroyed ${d.systemId}; OEM slot on ${hostId} is free for another VM.\n`,
      );
      results.push({ ok: true, system_id: d.systemId, destroyed: true, vmid });
    } catch (e) {
      ok = false;
      results.push({
        ok: false,
        system_id: d.systemId,
        message: String(/** @type {Error} */ (e).message || e),
      });
    }
  }

  const payload = { ok, target, verb, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  await runOperationReportTail({
    clumpRoot,
    clumpId: target,
    verb,
    ok,
    argv: process.argv.slice(2),
    stdoutPayload: payload,
    repoRoot: root,
    readLineQuestion: deps.readLineQuestion,
  });

  process.exitCode = ok ? 0 : 1;
}

main();
