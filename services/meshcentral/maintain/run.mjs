#!/usr/bin/env node
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
/**
 * Maintain MeshCentral: re-push compose stack, guest baseline, and optional device ops.
 *
 * Usage: hdc run service meshcentral maintain -- [--instance a | --system-id meshcentral-a]
 *        hdc run service meshcentral maintain -- [--skip-upgrade] [--skip-clamav]
 *        hdc run service meshcentral maintain -- --device lan-1 --power wake
 *        hdc run service meshcentral maintain -- --device lan-1 --updates
 *        hdc run service meshcentral maintain -- --device lan-1 --install "Git.Git"
 *        hdc run service meshcentral maintain -- --device lan-1 --remove "Git.Git"
 *        hdc run service meshcentral maintain -- --device lan-1 --disk
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
import { resolveMeshcentralDeployments } from "hdc/package/deployments.mjs";
import { maintainMeshcentralInCt, resolvePveSshForHost } from "hdc/package/meshcentral-install.mjs";
import { resolveMeshcentralSecrets } from "hdc/package/vault-secrets.mjs";
import { parseDeviceSelectors, resolveDevices } from "hdc/package/meshcentral-devices.mjs";
import { applyDevicePower } from "hdc/package/meshcentral-power.mjs";
import {
  collectDisk,
  installPackage,
  removePackage,
  runOsUpdates,
} from "hdc/package/meshcentral-ops.mjs";
import {
  listNormalizedDevices,
  meshcentralFromDeployments,
  openMeshcentralSession,
} from "hdc/package/meshcentral-session.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/meshcentral/config.example.json";
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
 * @param {ReturnType<typeof resolveMeshcentralDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 */
async function maintainOne(deployment, flags, vaultAccess) {
  const { systemId, proxmox: px, meshcentral, install } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;

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
  const meshcentralCfg = isObject(meshcentral) ? meshcentral : {};
  const installCfg = isObject(install) ? install : {};
  let mongoPassword = "";
  try {
    const secrets = await resolveMeshcentralSecrets(vaultAccess, meshcentralCfg);
    mongoPassword = secrets.mongoPassword;
  } catch (e) {
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      message: String(/** @type {Error} */ (e).message || e),
    };
  }
  const result = await maintainMeshcentralInCt(
    pveSsh.user,
    pveSsh.host,
    vmid,
    meshcentralCfg,
    installCfg,
    mongoPassword,
    { skipUpgrade },
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

  return {
    ok: result.ok && baseline.ok,
    system_id: systemId,
    host_id: hostId,
    vmid,
    skip_upgrade: skipUpgrade,
    hostname: result.hostname ?? null,
    public_url: result.public_url ?? null,
    service: result.service ?? null,
    message: result.message,
    ...guestBaselineResultFields(baseline),
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {string[]} argv
 * @param {ReturnType<typeof createPackageVaultAccess>} vaultAccess
 */
async function maintainDevices(cfg, flags, argv, vaultAccess) {
  const log = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
  const dryRun = flagGet(flags, "dry-run", "dry_run") !== undefined;
  const power = flagGet(flags, "power");
  const doUpdates = flagGet(flags, "updates") !== undefined;
  const installPkg = flagGet(flags, "install");
  const removePkg = flagGet(flags, "remove");
  const doDisk = flagGet(flags, "disk") !== undefined;
  const selectors = parseDeviceSelectors(flags, argv);

  if (!selectors.length) {
    return { ok: false, message: "device ops require --device <id|name|node_id>" };
  }
  if (!power && !doUpdates && !installPkg && !removePkg && !doDisk) {
    return {
      ok: false,
      message: "specify at least one of --power, --updates, --install, --remove, --disk",
    };
  }

  const deployments = resolveMeshcentralDeployments(cfg, flags);
  const meshcentral = meshcentralFromDeployments(deployments);
  const session = await openMeshcentralSession({ vault: vaultAccess, meshcentral, log });
  try {
    const { live, configDevices } = await listNormalizedDevices(session.client, meshcentral);
    const resolved = resolveDevices({ liveDevices: live, configDevices, selectors });
    if (!resolved.ok) {
      return { ok: false, message: resolved.message };
    }

    /** @type {Record<string, unknown>[]} */
    const results = [];
    let allOk = true;

    for (const device of resolved.devices) {
      /** @type {Record<string, unknown>} */
      const row = {
        id: device.id,
        name: device.name,
        node_id: device.node_id,
        platform: device.platform,
        online: device.online,
      };
      let deviceOk = true;
      const nodeId = typeof device.node_id === "string" ? device.node_id : "";
      if (!nodeId) {
        row.ok = false;
        row.message = "missing MeshCentral node_id (run query --import --yes)";
        allOk = false;
        results.push(row);
        continue;
      }

      if (power) {
        if (power !== "wake" && power !== "on" && !device.online) {
          row.ok = false;
          row.message = `device offline; cannot power ${power} (use --power wake)`;
          allOk = false;
          results.push(row);
          continue;
        }
        row.power = await applyDevicePower(session.client, [nodeId], power, { dryRun, log });
        if (!row.power.ok) deviceOk = false;
      }

      const needsAgent = doUpdates || installPkg || removePkg || doDisk;
      if (needsAgent && !device.online && !dryRun) {
        row.ok = false;
        row.message = "device offline; agent required for updates/software/disk";
        allOk = false;
        results.push(row);
        continue;
      }

      if (doDisk) {
        row.disk = await collectDisk(session.client, device, { dryRun, log });
        if (!row.disk.ok) deviceOk = false;
      }
      if (doUpdates) {
        row.updates = await runOsUpdates(session.client, device, { dryRun, log });
        if (!row.updates.ok) deviceOk = false;
      }
      if (installPkg && installPkg !== "1") {
        row.install = await installPackage(session.client, device, installPkg, { dryRun, log });
        if (!row.install.ok) deviceOk = false;
      }
      if (removePkg && removePkg !== "1") {
        row.remove = await removePackage(session.client, device, removePkg, { dryRun, log });
        if (!row.remove.ok) deviceOk = false;
      }

      row.ok = deviceOk;
      if (!deviceOk) allOk = false;
      results.push(row);
    }

    return { ok: allOk, dry_run: dryRun, count: results.length, results };
  } finally {
    await session.client.close();
  }
}

/**
 * True when argv requests device-level ops (skip guest compose maintain if only device ops).
 * @param {Record<string, string>} flags
 * @param {string[]} argv
 */
function hasDeviceOps(flags, argv) {
  const selectors = parseDeviceSelectors(flags, argv);
  if (!selectors.length) return false;
  return (
    flagGet(flags, "power") !== undefined ||
    flagGet(flags, "updates") !== undefined ||
    flagGet(flags, "install") !== undefined ||
    flagGet(flags, "remove") !== undefined ||
    flagGet(flags, "disk") !== undefined
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const deviceOnly = hasDeviceOps(flags, argv);

  errout.write(
    `[hdc] ${target} ${verb}: ${deviceOnly ? "MeshCentral device ops" : "refresh MeshCentral Docker stack"} (stderr log; JSON on stdout).\n`,
  );

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});

  if (deviceOnly) {
    let devicePayload;
    try {
      devicePayload = await maintainDevices(cfg, flags, argv, vaultAccess);
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: device ops failed: ${msg}\n`);
      devicePayload = { ok: false, message: msg };
    }
    const ok = Boolean(devicePayload.ok);
    const payload = { ok, target, verb, device_ops: devicePayload };
    runOperationReportTail({
      clumpRoot,
      repoRoot: root,
      verb,
      argv,
      payload,
      ok,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  let deployments;
  try {
    deployments = resolveMeshcentralDeployments(cfg, flags);
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
    argv,
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
