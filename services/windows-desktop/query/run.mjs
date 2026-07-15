#!/usr/bin/env node
/**
 * Query windows-desktop deployments (config summary; --live for VM + OEM on hypervisor).
 *
 * Usage: hdc run service windows-desktop query -- [--instance a] [--live]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { locateGuest } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import { resolveWindowsDesktopDeployments } from "hdc/package/deployments.mjs";
import { queryOemStatusOnHost, queryVmPowerState } from "hdc/package/query-status.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;
  const deps = createNodeCliDeps();
  const cfg = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: "clumps/services/windows-desktop/config.example.json",
  }).data;

  errout.write(`[hdc] ${target} ${verb}: config summary${live ? " (live)" : ""}.\n`);

  const deployments = resolveWindowsDesktopDeployments(cfg, flags);
  /** @type {Record<string, unknown>[]} */
  const instances = [];

  for (const d of deployments) {
    /** @type {Record<string, unknown>} */
    const row = {
      system_id: d.systemId,
      host_id: d.proxmox.hostId,
      hostname: d.hostname,
      vmid: d.proxmox.qemu.vmid ?? null,
      ip: d.proxmox.qemu.ip ?? null,
      windows_iso: d.proxmox.iso.windows_volid,
      virtio_iso: d.proxmox.iso.virtio_volid,
      oem_enabled: d.proxmox.oem.enabled !== false,
    };

    if (live && row.vmid) {
      const vmid = Number(row.vmid);
      try {
        const auth = await authorizeProxmoxForHost({
          clumpRoot: proxmoxRoot,
          hostId: d.proxmox.hostId,
        });
        const located = await locateGuest(
          auth.host.apiBase,
          auth.authorization,
          auth.rejectUnauthorized,
          vmid,
        );
        if (located) {
          const power = await queryVmPowerState({
            apiBase: auth.host.apiBase,
            authorization: auth.authorization,
            rejectUnauthorized: auth.rejectUnauthorized,
            node: located.node,
            vmid,
          });
          row.power_status = power.status;
          row.node = located.node;
        } else {
          row.power_status = "not_provisioned";
        }
        const oem = await queryOemStatusOnHost({
          proxmoxRoot,
          hostId: d.proxmox.hostId,
          pveNode: auth.host.pveNode,
          spawnSync: deps.spawnSync,
          env: deps.env,
        });
        row.oem = oem;
      } catch (e) {
        row.live_error = String(/** @type {Error} */ (e).message || e);
      }
    }

    instances.push(row);
  }

  const payload = { ok: true, target, verb, instances };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main();
