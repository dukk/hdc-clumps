#!/usr/bin/env node
/**
 * Teardown jevos Proxmox LXC deployments.
 *
 * Usage: hdc run service jevos teardown -- [--instance a | --system-id jevos-a] [--dry-run] [--yes]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { stopAndDestroyLxc } from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { findClusterGuest } from "../../ollama/lib/guest-exists.mjs";
import { confirmTeardown, teardownDryRun } from "../../ollama/lib/teardown-confirm.mjs";
import { resolveJevosDeployments } from "../lib/deployments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const root = repoRoot();

/**
 * @param {ReturnType<typeof resolveJevosDeployments>[number]} d
 * @param {Record<string, string>} flags
 */
async function teardownOne(d, flags) {
  const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
  const hostId = String(d.proxmox.host_id);
  const vmid = Number(d.proxmox.lxc?.vmid);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await findClusterGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  if (!located) {
    return { ok: true, system_id: d.systemId, skipped: true, vmid, message: "guest not found" };
  }
  const detail = `vmid ${vmid} on ${located.node}${located.name ? ` (${located.name})` : ""}`;
  if (teardownDryRun(flags)) {
    errout.write(`[hdc] ${target} ${verb}: [dry-run] would destroy ${d.systemId}: ${detail}\n`);
    return { ok: true, system_id: d.systemId, dry_run: true, vmid, node: located.node };
  }
  if (!(await confirmTeardown(d.systemId, detail, flags))) {
    return { ok: true, system_id: d.systemId, skipped: true, message: "cancelled", vmid };
  }
  await stopAndDestroyLxc({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: located.node,
    vmid,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${d.systemId}: ${line}\n`),
  });
  return { ok: true, system_id: d.systemId, destroyed: true, vmid, node: located.node };
}

async function main() {
  const cfg = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: "clumps/services/jevos/config.example.json" });
  const flags = parseArgvFlags(process.argv.slice(2));
  const results = [];
  for (const d of resolveJevosDeployments(cfg.data, flags)) {
    try {
      results.push(await teardownOne(d, flags));
    } catch (e) {
      results.push({ ok: false, system_id: d.systemId, message: String(e?.message || e) });
    }
  }
  const ok = results.every((r) => r.ok);
  const payload = { ok, target, verb, count: results.length, results };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: String(e?.message || e) }, null, 2)}\n`);
  process.exitCode = 1;
});
