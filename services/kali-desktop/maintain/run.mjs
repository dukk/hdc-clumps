#!/usr/bin/env node
/**
 * Maintain Kali desktop: guest Linux baseline, optional apt upgrade, resource sync.
 *
 * Usage: hdc run service kali-desktop maintain -- [--instance a]
 *        [--skip-package-upgrade] [--skip-clamav] [--skip-resources]
 */
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { fetchClusterVmResources } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { syncProxmoxGuestResourcesOnMaintain } from "hdc/package/proxmox-guest-resources-maintain.mjs";
import { locateGuestByName } from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";

import {
  mergedProxmoxBlock,
  normalizeKaliDesktopConfig,
  resolveKaliDesktopDeployments,
} from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/kali-desktop/config.example.json";
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<typeof resolveKaliDesktopDeployments>[number]} deployment
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} vaultAccess
 */
async function maintainOne(deployment, defaults, flags, vaultAccess) {
  const { systemId, proxmox: pxRaw, configure, hostname: cfgHostname } = deployment;
  const skipUpgrade = flagGet(flags, "skip-package-upgrade", "skip_package_upgrade") !== undefined;
  const skipResources = flagGet(flags, "skip-resources", "skip_resources") !== undefined;

  const px = mergedProxmoxBlock(defaults, pxRaw);
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const q = isObject(px.qemu) ? px.qemu : {};
  const guestName =
    cfgHostname ||
    systemId.replace(/^vm-/, "").slice(0, 63);
  let vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);

  errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${hostId} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });

  if (!Number.isFinite(vmid) || vmid <= 0) {
    const resources = await fetchClusterVmResources(
      auth.host.apiBase,
      auth.authorization,
      auth.rejectUnauthorized,
    );
    const byName = locateGuestByName(resources, guestName);
    if (!byName) {
      return {
        ok: false,
        system_id: systemId,
        message: `guest ${guestName} not found — set proxmox.qemu.vmid or deploy first`,
      };
    }
    vmid = byName.vmid;
    errout.write(`[hdc] ${target} ${verb}: resolved vmid ${vmid} by name ${guestName}.\n`);
  } else {
    errout.write(`[hdc] ${target} ${verb}: vmid ${vmid} …\n`);
  }

  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );
  if (!located) {
    return { ok: false, system_id: systemId, vmid, message: "guest not found in cluster" };
  }

  let resourceSync = { ok: true, skipped: true };
  if (!skipResources) {
    resourceSync = await syncProxmoxGuestResourcesOnMaintain({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: located.node,
      vmid,
      guestType: "qemu",
      sizing: q,
      flags,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
  }

  const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
  const sshUser = resolveGuestSshUser(sshCfg.user || "kali");
  const ip = typeof q.ip === "string" ? q.ip.split("/")[0] : "";
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip;
  if (!sshHost) {
    return { ok: false, system_id: systemId, message: "configure.ssh.host or proxmox.qemu.ip required" };
  }

  const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
  const log = provisionLogFromConsole(console);

  let aptUpgrade = { ok: true, skipped: skipUpgrade };
  if (!skipUpgrade) {
    errout.write(`[hdc] ${target} ${verb}: apt upgrade on ${sshUser}@${sshHost} …\n`);
    const r = exec.run(
      "DEBIAN_FRONTEND=noninteractive apt-get -qq update && apt-get -qq -y upgrade",
      { capture: true },
    );
    aptUpgrade = { ok: r.status === 0, exit_code: r.status, skipped: false };
  }

  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags,
    vaultAccess,
    deployment: { system_id: systemId, proxmox: px, configure },
    proxmoxPackageRoot: proxmoxRoot,
  });

  return {
    ok: resourceSync.ok && aptUpgrade.ok && baseline.ok,
    system_id: systemId,
    host_id: hostId,
    vmid,
    node: located.node,
    resource_sync: resourceSync,
    apt_upgrade: aptUpgrade,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Kali desktop maintain.\n`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const cfg = ensurePackageConfig().data;
  const { defaults } = normalizeKaliDesktopConfig(cfg);
  const vaultAccess = createPackageVaultAccess(createNodeCliDeps());

  const deployments = resolveKaliDesktopDeployments(cfg, flags);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let allOk = true;

  for (const d of deployments) {
    try {
      const r = await maintainOne(d, defaults, flags, vaultAccess);
      results.push(r);
      if (!r.ok) allOk = false;
    } catch (e) {
      allOk = false;
      results.push({ ok: false, system_id: d.systemId, message: String(/** @type {Error} */ (e).message || e) });
    }
  }

  const payload = { ok: allOk, target, verb, deployments: results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  await runOperationReportTail({
    target,
    verb,
    clumpRoot,
    payload,
    flags,
    log: (line) => errout.write(`${line}\n`),
  });
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${e.message || e}\n`);
  process.exitCode = 1;
});
