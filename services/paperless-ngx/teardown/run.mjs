#!/usr/bin/env node
/**
 * Teardown paperless-ngx Proxmox LXC deployments.
 *
 * Usage: hdc run service paperless-ngx teardown -- [--instance a | --system-id paperless-ngx-a]
 *        hdc run service paperless-ngx teardown -- [--dry-run] [--yes] [--skip-compose-down]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { stopAndDestroyLxc } from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { stopAndDestroyQemu } from "../../ollama/lib/proxmox-qemu-redeploy.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolvePaperlessNgxDeployments } from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import {
  composeDownInCt,
  composeDownOnGuest,
  resolvePveSshForHost,
} from "hdc/package/paperless-ngx-install.mjs";
import { confirmTeardown, teardownDryRun } from "../../ollama/lib/teardown-confirm.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/paperless-ngx/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
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
 * @param {ReturnType<typeof resolvePaperlessNgxDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function teardownOne(deployment, flags) {
  const { mode, systemId, proxmox: px, configure, install } = deployment;
  const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
  const dryRun = teardownDryRun(flags);
  const skipComposeDown = flagGet(flags, "skip-compose-down", "skip_compose_down") !== undefined;

  if (mode !== "proxmox-lxc" && mode !== "proxmox-qemu") {
    return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  }

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const lxc = isObject(px.lxc) ? px.lxc : {};
  const qemu = isObject(px.qemu) ? px.qemu : {};
  const vmid =
    mode === "proxmox-qemu"
      ? typeof qemu.vmid === "number"
        ? qemu.vmid
        : Number(qemu.vmid)
      : typeof lxc.vmid === "number"
        ? lxc.vmid
        : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: locating ${JSON.stringify(systemId)} vmid ${vmid} (host ${JSON.stringify(hostId)}) …\n`,
  );
  errout.write(`[hdc] ${target} ${verb}: authorizing Proxmox API for host ${JSON.stringify(hostId)} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });

  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );

  if (!located) {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} not in cluster — nothing to destroy.\n`);
    return {
      ok: true,
      system_id: systemId,
      host_id: hostId,
      mode,
      skipped: true,
      message: "guest not found",
      vmid,
    };
  }

  const guestName = located.name ? String(located.name) : "";
  const detail = `vmid ${vmid} on ${located.node}${guestName ? ` (${guestName})` : ""}`;

  if (dryRun) {
    errout.write(`[hdc] ${target} ${verb}: [dry-run] would destroy ${systemId}: ${detail}\n`);
    return {
      ok: true,
      system_id: systemId,
      host_id: hostId,
      mode,
      dry_run: true,
      vmid,
      node: located.node,
      message: "dry-run",
    };
  }

  let proceed;
  try {
    proceed = await confirmTeardown(systemId, detail, flags);
  } catch (e) {
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      mode,
      message: String(/** @type {Error} */ (e).message || e),
    };
  }
  if (!proceed) {
    errout.write(`[hdc] ${target} ${verb}: cancelled ${systemId}.\n`);
    return {
      ok: true,
      system_id: systemId,
      host_id: hostId,
      mode,
      skipped: true,
      message: "cancelled",
      vmid,
      node: located.node,
    };
  }

  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`);

  if (!skipComposeDown) {
    try {
      const installCfg = isObject(install) ? install : {};
      if (mode === "proxmox-qemu") {
        const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
        const sshUser = resolveGuestSshUser(sshCfg.user);
        const ip = typeof qemu.ip === "string" ? qemu.ip.trim() : "";
        const sshHost =
          typeof sshCfg.host === "string" && sshCfg.host.trim()
            ? sshCfg.host.trim()
            : ip.split("/")[0];
        if (sshHost) {
          errout.write(`[hdc] ${target} ${verb}: stopping Docker Compose on ${sshUser}@${sshHost} …\n`);
          const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
          composeDownOnGuest(exec, installCfg);
        }
      } else {
        const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
        errout.write(`[hdc] ${target} ${verb}: stopping Docker Compose in CT ${vmid} …\n`);
        composeDownInCt(pveSsh.user, pveSsh.host, vmid, installCfg);
      }
    } catch (e) {
      errout.write(
        `[hdc] ${target} ${verb}: compose down warning: ${String(/** @type {Error} */ (e).message || e)}\n`,
      );
    }
  }

  try {
    if (mode === "proxmox-qemu") {
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log: logLine,
      });
    } else {
      await stopAndDestroyLxc({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log: logLine,
      });
    }
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${systemId} destroy failed: ${msg}\n`);
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      mode,
      vmid,
      node: located.node,
      message: msg,
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
    message: mode === "proxmox-qemu" ? `qemu ${vmid} destroyed` : `lxc ${vmid} destroyed`,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: tear down paperless-ngx guest (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolvePaperlessNgxDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await teardownOne(deployment, flags));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
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
