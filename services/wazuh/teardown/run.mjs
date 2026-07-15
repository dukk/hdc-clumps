#!/usr/bin/env node
/**
 * Teardown Wazuh Proxmox LXC or QEMU deployments.
 *
 * Usage: hdc run service wazuh teardown -- [--instance a | --system-id vm-wazuh-a]
 *        hdc run service wazuh teardown -- [--dry-run] [--yes] [--skip-compose-down]
 */
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { stopAndDestroyLxc } from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { resolveWazuhDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import { composeDownInCt, composeDownOnHost, resolvePveSshForHost } from "hdc/package/wazuh-install.mjs";
import { stopAndDestroyQemu } from "hdc/package/proxmox-qemu-redeploy.mjs";
import { confirmTeardown, teardownDryRun } from "../../ollama/lib/teardown-confirm.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/wazuh/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let pkgConfig = null;
function ensurePackageConfig() {
  if (!pkgConfig) pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  return pkgConfig;
}

const root = repoRoot();

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolveWazuhDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function teardownOne(deployment, flags) {
  const { mode, systemId, proxmox: px, install, configure } = deployment;
  const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
  const dryRun = teardownDryRun(flags);
  const skipComposeDown = flagGet(flags, "skip-compose-down", "skip_compose_down") !== undefined;

  if (!isObject(px)) return { ok: false, system_id: systemId, message: "bad proxmox config" };
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return { ok: false, system_id: systemId, message: "missing host_id" };

  const isQemu = mode === "proxmox-qemu";
  const vmid = isQemu
    ? (() => {
        const q = isObject(px.qemu) ? px.qemu : {};
        return typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
      })()
    : (() => {
        const lxc = isObject(px.lxc) ? px.lxc : {};
        return typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
      })();

  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await findClusterGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  if (!located) {
    return { ok: true, system_id: systemId, host_id: hostId, mode, skipped: true, message: "guest not found", vmid };
  }

  const detail = `vmid ${vmid} on ${located.node}${located.name ? ` (${located.name})` : ""}`;
  if (dryRun) {
    return { ok: true, system_id: systemId, host_id: hostId, mode, dry_run: true, vmid, node: located.node, message: "dry-run" };
  }

  const proceed = await confirmTeardown(systemId, detail, flags);
  if (!proceed) {
    return { ok: true, system_id: systemId, host_id: hostId, mode, skipped: true, message: "cancelled", vmid, node: located.node };
  }

  const installCfg = isObject(install) ? install : {};
  if (!skipComposeDown) {
    try {
      if (isQemu) {
        const cfg = isObject(configure) ? configure : {};
        const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
        const user = resolveGuestSshUser(ssh.user);
        const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
        if (host) {
          const exec = createConfigureExec("ssh", { user, host });
          composeDownOnHost(exec, installCfg);
        }
      } else {
        const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
        composeDownInCt(pveSsh.user, pveSsh.host, vmid, installCfg);
      }
    } catch {
      // best-effort
    }
  }

  try {
    if (isQemu) {
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
      });
    } else {
      await stopAndDestroyLxc({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
      });
    }
  } catch (e) {
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      mode,
      vmid,
      node: located.node,
      message: String(/** @type {Error} */ (e).message || e),
    };
  }

  return {
    ok: true,
    system_id: systemId,
    host_id: hostId,
    mode,
    destroyed: true,
    vmid,
    node: located.node,
    message: isQemu ? `qemu ${vmid} destroyed` : `lxc ${vmid} destroyed`,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: tear down Wazuh guests (stderr log; JSON on stdout).\n`);
  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: "clump config missing - see stderr" }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolveWazuhDeployments(cfg, flags);
  } catch (e) {
    const message = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await teardownOne(deployment, flags));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
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
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
