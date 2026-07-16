#!/usr/bin/env node
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
/**
 * Maintain hdc-agents: re-push Dockerfile + compose, rebuild image, guest Linux baseline.
 *
 * Usage: hdc run service hdc-agents maintain -- [--instance a | --system-id hdc-agents-a]
 *        hdc run service hdc-agents maintain -- [--skip-upgrade] [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { hdcPrivateRoot } from "hdc/cli/lib/private-repo.mjs";
import { resolveHdcAgentsDeployments } from "hdc/package/deployments.mjs";
import {
  maintainHdcAgentsInCt,
  readCtPrimaryIp,
  resolvePveSshForHost,
} from "hdc/package/hdc-agents-install.mjs";
import { prepareAgentsGuestSecrets } from "hdc/package/hdc-agents-guest-secrets.mjs";
import { syncHdcTreesToGuest, syncHdcTreesViaPct } from "hdc/package/hdc-agents-sync.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { registerFleetA2aOnLitellm } from "../lib/litellm-a2a-register.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/hdc-agents/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolveHdcAgentsDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 */
async function maintainOne(deployment, flags, vaultAccess) {
  const { systemId, proxmox: px, hdc_agents, install } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  const skipSync = flagGet(flags, "skip-sync", "skip_sync") !== undefined;
  const rotateMcpKeys = flagGet(flags, "rotate-mcp-keys", "rotate_mcp_keys") !== undefined;

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} on ${hostId} …\n`);
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const hdcAgentsCfg = isObject(hdc_agents) ? hdc_agents : {};
  const installCfg = isObject(install) ? install : {};
  const metaRoot =
    typeof installCfg.meta_root === "string" && installCfg.meta_root.trim()
      ? installCfg.meta_root.trim()
      : "/opt/hdc-agents-meta";

  const privateRoot = hdcPrivateRoot(root);
  if (!privateRoot) {
    return { ok: false, system_id: systemId, message: "hdc-private not resolved" };
  }

  const guestSecrets = await prepareAgentsGuestSecrets({
    vault: vaultAccess,
    privateRoot,
    hdcAgents: hdcAgentsCfg,
    rotateMcpKeys,
  });

  const guestIp = readCtPrimaryIp(pveSsh.user, pveSsh.host, vmid);
  if (!skipSync && guestIp) {
    const syncExcludes = Array.isArray(
      /** @type {Record<string, unknown>} */ (hdcAgentsCfg.sync || {}).exclude,
    )
      ? /** @type {string[]} */ (
          /** @type {Record<string, unknown>} */ (hdcAgentsCfg.sync).exclude
        )
      : [".git", "node_modules", "**/reports"];
    syncExcludes.push(
      "operations/tasks/**",
      "operations/task-report.md",
      "operations/.dispatcher-state.json",
    );
    errout.write(`[hdc] ${target} ${verb}: syncing hdc trees → ${guestIp} …\n`);
    let syncResult = syncHdcTreesToGuest({
      publicRoot: root,
      remoteUser: "hdc",
      remoteHost: guestIp,
      installRoot: "/opt/hdc-src",
      privateRoot: "/opt/hdc-private",
      exclude: syncExcludes,
      log: {
        info: (m) => errout.write(`[hdc] ${target} ${verb}: ${m}\n`),
      },
    });
    if (!syncResult.ok) {
      errout.write(
        `[hdc] ${target} ${verb}: guest SSH sync failed (${syncResult.message}); falling back to pct …\n`,
      );
      syncResult = syncHdcTreesViaPct({
        publicRoot: root,
        pveUser: pveSsh.user,
        pveHost: pveSsh.host,
        vmid,
        installRoot: "/opt/hdc-src",
        privateRoot: "/opt/hdc-private",
        exclude: syncExcludes,
        log: {
          info: (m) => errout.write(`[hdc] ${target} ${verb}: ${m}\n`),
        },
      });
    }
    if (!syncResult.ok) {
      errout.write(
        `[hdc] ${target} ${verb}: sync warning: ${syncResult.message} (continuing with guest tree)\n`,
      );
    }
  }

  const result = await maintainHdcAgentsInCt(
    pveSsh.user,
    pveSsh.host,
    vmid,
    hdcAgentsCfg,
    installCfg,
    {
      skipUpgrade,
      composeEnv: guestSecrets.composeEnv,
      schedulesJson: guestSecrets.schedulesJson,
      mailboxJson: guestSecrets.mailboxJson,
      notificationsJson: guestSecrets.notificationsJson,
      metaRoot,
    },
  );

  const log = provisionLogFromConsole(console);
  const exec = createConfigureExec("pct", {
    user: pveSsh.user,
    host: pveSsh.host,
    vmid,
    pveHost: pveSsh.host,
  });
  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags,
    vaultAccess,
    deployment,
    proxmoxPackageRoot: proxmoxRoot,
  });

  const skipLitellmRegister =
    flagGet(flags, "skip-litellm-register", "skip_litellm_register") !== undefined;
  /** @type {Record<string, unknown> | null} */
  let litellm_register = null;
  const regIp = result.guest_ip ?? guestIp;
  if (!skipLitellmRegister && result.ok && regIp) {
    litellm_register = await registerFleetA2aOnLitellm({
      hdcRoot: root,
      privateRoot,
      guestIp: regIp,
      hdcAgents: hdcAgentsCfg,
      dryRun: flagGet(flags, "dry-run", "dry_run") !== undefined,
      skipLitellmMaintain:
        flagGet(flags, "skip-litellm-maintain", "skip_litellm_maintain") !== undefined,
      log: (m) => errout.write(`[hdc] ${target} ${verb}: ${m}\n`),
    });
  }

  return {
    ok: result.ok && baseline.ok,
    system_id: systemId,
    host_id: hostId,
    vmid,
    skip_upgrade: skipUpgrade,
    url: result.url ?? result.web_url ?? null,
    upstream_url: result.upstream_url ?? null,
    message: result.message,
    litellm_register,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(
    `[hdc] ${target} ${verb}: refresh hdc-agents Docker stack (stderr log; JSON on stdout).\n`,
  );

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  let deployments;
  try {
    deployments = resolveHdcAgentsDeployments(cfg, flags);
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
      results.push(await maintainOne(deployment, flags, vaultAccess));
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
