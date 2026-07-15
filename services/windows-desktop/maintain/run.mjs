#!/usr/bin/env node
/**
 * Maintain Windows desktop VMs — re-apply OEM MSDM/SLIC + SMBIOS on Proxmox guests.
 *
 * Usage: hdc run service windows-desktop maintain -- [--instance a | --system-id vm-win11-a]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { locateGuest } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";

import { resolveWindowsDesktopDeployments } from "hdc/package/deployments.mjs";
import { ensureOemLicenseForVm } from "hdc/package/oem-apply.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  const deps = createNodeCliDeps();
  const cfg = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: "clumps/services/windows-desktop/config.example.json",
  }).data;

  errout.write(`[hdc] ${target} ${verb}: re-applying OEM license passthrough.\n`);

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  for (const deployment of resolveWindowsDesktopDeployments(cfg, flags)) {
    const px = deployment.proxmox;
    const hostId = px.hostId;
    const vmid = Number(px.qemu.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      results.push({
        ok: false,
        system_id: deployment.systemId,
        message: "proxmox.qemu.vmid required for maintain",
      });
      ok = false;
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
        throw new Error(`vmid ${vmid} not found in cluster`);
      }
      const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
      const sshTarget = { id: hostId, host: pveSsh.host, user: pveSsh.user, clusterId: null };
      const oem = px.oem;
      if (oem.enabled === false || oem.enabled === 0) {
        results.push({ ok: true, system_id: deployment.systemId, skipped_oem: true });
        continue;
      }
      const prepared = await ensureOemLicenseForVm({
        sshTarget,
        pveNode: auth.host.pveNode,
        apiBase: auth.host.apiBase,
        node: located.node,
        vmid,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        spawnSync: deps.spawnSync,
        env: deps.env,
        requireFirmware: false,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
        warn: (line) => errout.write(`[hdc] ${target} ${verb}: WARN ${line}\n`),
      });
      results.push({
        ok: true,
        system_id: deployment.systemId,
        vmid,
        oem_status: prepared.hostResult.status,
        oem_summary: prepared.hostResult.summary,
      });
    } catch (e) {
      ok = false;
      results.push({
        ok: false,
        system_id: deployment.systemId,
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
