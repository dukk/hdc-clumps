#!/usr/bin/env node
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Maintain Pi-hole (gravity update, optional core update, optional network apply).
 *
 * Usage: hdc run service pi-hole maintain -- [--instance a | --system-id pi-hole-a] [--skip-core-update]
 *        hdc run service pi-hole maintain -- --apply-network [--dry-run]
 *        [--skip-allowlist] [--prune] [--skip-resources] [--skip-admin-user] [--skip-clamav]
 *        [--no-reboot] [--reboot]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { buildNet0, gatewayFromProxmox, resolveLxcIpConfig } from "hdc/package/lxc-network.mjs";
import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { applyLxcNet0 } from "../../../infrastructure/proxmox/lib/proxmox-lxc-network.mjs";
import { syncProxmoxGuestResourcesOnMaintain } from "hdc/package/proxmox-guest-resources-maintain.mjs";
import { resolvePiHoleDeployments } from "hdc/package/deployments.mjs";
import { resolvePveSshForHost } from "hdc/package/pi-hole-install.mjs";
import { syncPiHoleAllowlistInCt } from "hdc/package/pi-hole-allowlist.mjs";
import { configurePiHoleInCt, maintainPiHoleInCt } from "hdc/package/pi-hole-configure.mjs";
import { piHoleReportExtraSections } from "hdc/package/pi-hole-report.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/pi-hole/config.example.json";
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
 * @param {ReturnType<typeof resolvePiHoleDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof createPackageVaultAccess>} vaultAccess
 */
async function maintainOne(deployment, flags, vaultAccess) {
  const { systemId, proxmox: px } = deployment;
  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!hostId || !Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, message: "missing host_id or vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${hostId} vmid ${vmid} …\n`);

  const guestResources = await syncProxmoxGuestResourcesOnMaintain({
    deployment,
    proxmoxPackageRoot: proxmoxRoot,
    flags,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
  });
  if (!guestResources.ok) {
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      guest_resources: guestResources,
      message: guestResources.message ?? "guest resource sync failed",
    };
  }

  const dryRun = flags["dry-run"] !== undefined;
  const applyNetwork = flags["apply-network"] !== undefined;
  /** @type {Record<string, unknown> | null} */
  let network = null;

  if (applyNetwork) {
    const gateway = gatewayFromProxmox(px);
    const ipConfig = resolveLxcIpConfig(lxc, { gateway });
    if (!ipConfig) {
      errout.write(
        `[hdc] ${target} ${verb}: ${systemId}: no static ip_config (set proxmox.lxc.ip_config or ip) — skipping network apply.\n`,
      );
      network = { ok: true, skipped: true, message: "no static ip_config in config" };
    } else {
      const bridge =
        typeof lxc.bridge === "string" && lxc.bridge.trim() ? lxc.bridge.trim() : "vmbr0";
      const net0 = buildNet0(bridge, ipConfig);
      errout.write(
        `[hdc] ${target} ${verb}: ${systemId}: apply network ${ipConfig} (net0=${net0}) …\n`,
      );
      const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
      const node = auth.host.pveNode;
      try {
        const applied = await applyLxcNet0({
          apiBase: auth.host.apiBase,
          authorization: auth.authorization,
          rejectUnauthorized: auth.rejectUnauthorized,
          node,
          vmid,
          net0,
          dryRun,
          log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
        });
        network = {
          ok: applied.ok,
          ip_config: ipConfig,
          applied: applied.net0,
          previous_net0: applied.previous_net0,
          ip: applied.ip,
          dry_run: applied.dry_run ?? false,
        };
        if (!applied.ok) {
          return {
            ok: false,
            system_id: systemId,
            host_id: hostId,
            vmid,
            network,
            message: "network apply failed",
          };
        }
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        errout.write(`[hdc] ${target} ${verb}: ${systemId}: network apply failed: ${msg}\n`);
        return {
          ok: false,
          system_id: systemId,
          host_id: hostId,
          vmid,
          network: { ok: false, ip_config: ipConfig, message: msg },
          message: msg,
        };
      }
    }
  }

  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const piholeCfg = isObject(deployment.pihole) ? deployment.pihole : {};
  const configure = configurePiHoleInCt(pveSsh.user, pveSsh.host, vmid, piholeCfg);
  const allowlist = syncPiHoleAllowlistInCt(pveSsh.user, pveSsh.host, vmid, piholeCfg, {
    prune: flags.prune !== undefined,
    skip: flags["skip-allowlist"] !== undefined,
  });
  const skipCoreUpdate = flags["skip-core-update"] !== undefined;
  const result = maintainPiHoleInCt(pveSsh.user, pveSsh.host, vmid, { skipCoreUpdate });

  errout.write(`[hdc] ${target} ${verb}: guest baseline on ${systemId} (vmid ${vmid}) …\n`);
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

  const ok =
    configure.ok &&
    allowlist.ok &&
    result.ok &&
    baseline.admin_user?.ok !== false &&
    baseline.clamav?.ok !== false &&
    (network === null || network.ok !== false);
  return {
    system_id: systemId,
    host_id: hostId,
    vmid,
    guest_resources: guestResources,
    configure,
    allowlist,
    ...result,
    ...guestBaselineResultFields(baseline),
    ok,
    network,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Pi-hole gravity/core update (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    errout.write(`[hdc] ${target} ${verb}: missing clumps/services/pi-hole/config.json\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing" }, null, 2)}\n`,
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
    deployments = resolvePiHoleDeployments(cfg, flags, { skipInstall: true });
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, unknown>[]} */
  const instances = [];
  for (const deployment of deployments) {
    try {
      instances.push(await maintainOne(deployment, flags, vaultAccess));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      instances.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = instances.every((r) => r.ok);
  const payload = { ok, target, verb, count: instances.length, instances };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    extraSections: piHoleReportExtraSections,
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

