#!/usr/bin/env node
/**
 * Deploy FreePBX 17 on a Debian 12 Proxmox QEMU guest.
 *
 * Usage: hdc run service freepbx deploy -- [--instance a]
 *        [--build-template] [--destroy-existing] [--skip-existing] [--redeploy-existing]
 *        [--skip-provision] [--skip-install] [--reinstall]
 *        [--backup-guest <name-or-vmid>] [--backup-storage nas-1]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { ensureQemuGuestAgentOnDeploy } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-install.mjs";
import {
  createProxmoxHostProvisioner,
  fetchClusterVmResources,
} from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { waitForQemuGuestSshAfterBoot } from "hdc/package/qemu-guest-ssh-wait.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { createGuestSshExec } from "hdc/package/guest-ssh-exec.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import {
  mergedProxmoxBlock,
  normalizeFreepbxConfig,
  resolveFreepbxDeployments,
} from "hdc/package/deployments.mjs";
import { applyKaliCloudInit } from "../../kali-desktop/lib/proxmox-kali-cloud-init.mjs";
import {
  allocateNextVmid,
  cloneQemuGuest,
  locateGuestByName,
  startQemuGuest,
  stopAndDestroyQemu,
} from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { assertStorageFree, ensureDebianCloudTemplate } from "hdc/package/debian-template.mjs";
import { applyFreepbx, installFreepbx } from "hdc/package/freepbx-guest.mjs";
import { buildApplyPayload } from "hdc/package/freepbx-settings.mjs";
import { snapshotBackupGuest } from "hdc/package/proxmox-backup.mjs";
import { createFreepbxVaultAccess, resolveOrCreateSecret } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/freepbx/config.example.json";
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

function destroyPolicy(flags) {
  return flagGet(flags, "destroy-existing", "destroy_existing") !== undefined;
}

function skipProvision(flags) {
  return flagGet(flags, "skip-provision", "skip_provision") !== undefined;
}

function buildTemplate(flags) {
  return flagGet(flags, "build-template", "build_template") !== undefined;
}

function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing", "skip_existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing", "redeploy_existing") !== undefined) return "redeploy";
  if (destroyPolicy(flags)) return "destroy";
  return "skip";
}

/**
 * Sangoma packages conflict with unattended-upgrades. ClamAV scans are heavy on 4 GiB.
 * @param {Record<string, string>} flags
 */
function baselineFlags(flags) {
  return {
    ...flags,
    "skip-unattended-upgrades": flags["enable-unattended-upgrades"] ? "" : "1",
    "skip-clamav-scan": flags["clamav-scan"] ? "" : "1",
  };
}

/**
 * @param {ReturnType<typeof resolveFreepbxDeployments>[number]} deployment
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown>} freepbx
 * @param {{ adminPassword: string; debianPassword: string; sipUsername: string; sipPassword: string }} secrets
 * @param {Record<string, string>} flags
 * @param {import("hdc/package/host-provisioner.mjs").ProvisionLog} log
 * @param {ReturnType<typeof createFreepbxVaultAccess>} vaultAccess
 */
async function deployOne(deployment, defaults, freepbx, secrets, flags, log, vaultAccess) {
  const { systemId, proxmox: pxRaw, configure, hostname: cfgHostname } = deployment;
  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);

  const px = mergedProxmoxBlock(defaults, pxRaw);
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) return { ok: false, system_id: systemId, message: "missing proxmox.host_id" };

  const q = isObject(px.qemu) ? px.qemu : {};
  const net = isObject(px.network) ? px.network : {};
  const templateVmid = Number(q.template_vmid);
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const gateway = typeof net.gateway === "string" && net.gateway.trim() ? net.gateway.trim() : "";
  const bridge = typeof net.bridge === "string" && net.bridge.trim() ? net.bridge.trim() : "vmbr0";
  const storage = typeof q.storage === "string" && q.storage.trim() ? q.storage.trim() : "local-lvm";
  const cores = Number(q.cores) || 2;
  const memoryMb = Number(q.memory_mb) || 4096;
  const rootfsGb = Number(q.rootfs_gb) || 64;
  const guestName = cfgHostname || systemId.replace(/^vm-/, "").slice(0, 63);
  const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
  const ciuser =
    typeof sshCfg.user === "string" && sshCfg.user.trim() ? sshCfg.user.trim() : "debian";
  const imageUrl =
    isObject(freepbx.image) && typeof freepbx.image.url === "string" ? freepbx.image.url.trim() : "";
  const templateName =
    typeof freepbx.template_name === "string" && freepbx.template_name.trim()
      ? freepbx.template_name.trim()
      : "debian-12-freepbx-template";
  const installUrl =
    typeof freepbx.install_script_url === "string" && freepbx.install_script_url.trim()
      ? freepbx.install_script_url.trim()
      : "https://github.com/FreePBX/sng_freepbx_debian_install/raw/master/sng_freepbx_debian_install.sh";

  if (!Number.isFinite(templateVmid) || templateVmid <= 0 || !ip || !gateway) {
    return { ok: false, system_id: systemId, message: "invalid template_vmid, ip, or gateway" };
  }
  if (!imageUrl) return { ok: false, system_id: systemId, message: "freepbx.image.url is required" };

  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
  errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${hostId} template ${templateVmid} IP ${ip} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const imageStorage =
    typeof q.image_storage === "string" && q.image_storage.trim() ? q.image_storage.trim() : "local";

  const wantTemplate = !skipProvision(flags);
  if (wantTemplate) {
    await assertStorageFree({
      apiBase: auth.host.apiBase,
      node: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      storage,
      needBytes: 8 * 1024 ** 3,
      log: logLine,
    });
    const templateResult = await ensureDebianCloudTemplate({
      apiBase: auth.host.apiBase,
      node: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      imageStorage,
      templateVmid,
      templateName,
      imageUrl,
      storage,
      memoryMb,
      cores,
      bridge,
      rootfsGb,
      forceRebuild: buildTemplate(flags) && destroyPolicy(flags),
      log: logLine,
    });
    if (!templateResult.ok) return { ok: false, system_id: systemId, template: templateResult };
  }

  let resources = await fetchClusterVmResources(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );
  const locatedByName = locateGuestByName(resources, guestName);
  const policy = existingGuestPolicy(flags);
  let guestVmid = Number(q.vmid);
  let cloneNode = auth.host.pveNode;

  if (!skipProvision(flags)) {
    if (locatedByName && policy === "skip") {
      logLine(`guest ${locatedByName.name} vmid ${locatedByName.vmid} exists — skipping provision`);
      return { ok: true, system_id: systemId, skipped: true, vmid: locatedByName.vmid };
    }
    if (locatedByName && policy === "destroy") {
      logLine(`destroying existing ${locatedByName.name} vmid ${locatedByName.vmid} on ${locatedByName.node}`);
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: locatedByName.node,
        vmid: locatedByName.vmid,
        log: logLine,
      });
      resources = await fetchClusterVmResources(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
      );
    }

    if (!locatedByName || policy === "destroy") {
      if (!Number.isFinite(guestVmid) || guestVmid <= 0) guestVmid = allocateNextVmid(resources, 200);
      logLine(`cloning template ${templateVmid} to vmid ${guestVmid} (${guestName})`);
      const prov = createProxmoxHostProvisioner({
        apiBase: auth.host.apiBase,
        pveNode: auth.host.pveNode,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        clumpId: target,
      });
      const provisionResult = await cloneQemuGuest({
        log,
        provisioner: prov,
        name: guestName,
        vmid: guestVmid,
        templateVmid,
        parameters: { ...q, vmid: guestVmid, template_vmid: templateVmid },
      });
      if (!provisionResult.ok) return { ok: false, system_id: systemId, provision: provisionResult };
      const waited = await waitForCloneTaskAndEnableAgent(
        provisionResult,
        auth,
        guestVmid,
        logLine,
        guestResourceOptsFromBlock(q, flags),
      );
      cloneNode = waited.node;
      guestVmid = waited.vmid;
      await applyKaliCloudInit({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: cloneNode,
        vmid: guestVmid,
        hostname: guestName,
        ipCidr: ip,
        gateway,
        ciuser,
        cipassword: secrets.debianPassword,
        log: logLine,
      });
      await startQemuGuest({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: cloneNode,
        vmid: guestVmid,
        log: logLine,
      });
    } else {
      guestVmid = locatedByName.vmid;
      cloneNode = locatedByName.node;
      logLine(`reusing ${locatedByName.name} vmid ${guestVmid} on ${cloneNode}`);
    }
  }

  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];
  let sshUser = resolveGuestSshUser(ciuser);
  if (!skipProvision(flags)) {
    const sshWait = await waitForQemuGuestSshAfterBoot({
      user: sshUser,
      host: sshHost,
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: cloneNode,
      vmid: guestVmid,
      freshClone: !locatedByName || policy === "destroy",
      proxmoxPackageRoot: proxmoxRoot,
      flags,
      log: logLine,
    });
    sshUser = sshWait.user;
    await ensureQemuGuestAgentOnDeploy({
      apiBase: auth.host.apiBase,
      node: cloneNode,
      vmid: guestVmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      sshUser,
      sshHost,
      log: logLine,
    });
  }

  const skipInstall = flagGet(flags, "skip-install", "skip_install") !== undefined;
  if (!skipInstall) {
    installFreepbx({
      user: sshUser,
      host: sshHost,
      installUrl,
      force: flagGet(flags, "reinstall") !== undefined,
      log: logLine,
    });
  } else {
    logLine("--skip-install set");
  }

  const payload = buildApplyPayload({
    freepbx,
    adminPassword: secrets.adminPassword,
    sipUsername: secrets.sipUsername,
    sipPassword: secrets.sipPassword,
  });
  applyFreepbx({ user: sshUser, host: sshHost, payload, log: logLine });

  const exec = createGuestSshExec({ host: sshHost, configuredUser: sshUser, log: logLine });
  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags: baselineFlags(flags),
    vaultAccess,
    deployment: {
      ...deployment,
      system_id: systemId,
      mode: "proxmox-qemu",
      proxmox: px,
    },
    proxmoxPackageRoot: proxmoxRoot,
    clumpId: target,
    repoRoot: root,
  });

  return {
    ok: baseline.ok !== false,
    system_id: systemId,
    host_id: hostId,
    vmid: guestVmid,
    ip: sshHost,
    web_ui: `https://${sshHost}/`,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: FreePBX 17 QEMU deploy (stderr log; JSON on stdout).\n`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const cfg = ensurePackageConfig().data;
  const norm = normalizeFreepbxConfig(cfg);
  const deployments = resolveFreepbxDeployments(cfg, flags);
  const log = provisionLogFromConsole(console);
  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);

  const backupGuest = flagGet(flags, "backup-guest", "backup_guest");
  if (backupGuest) {
    const hostId =
      deployments[0] && isObject(deployments[0].proxmox) && typeof deployments[0].proxmox.host_id === "string"
        ? deployments[0].proxmox.host_id
        : "";
    const storage = flagGet(flags, "backup-storage", "backup_storage") || "nas-1";
    const backup = await snapshotBackupGuest({
      proxmoxRoot,
      hostId,
      guestRef: backupGuest,
      storage,
      log: logLine,
    });
    const payload = { ok: true, target, verb, backup_only: true, backup };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    runOperationReportTail({
      clumpRoot,
      repoRoot: root,
      verb,
      argv: process.argv.slice(2),
      payload,
      ok: true,
      log: logLine,
    });
    return;
  }

  const fp = norm.freepbx;
  const twilio = isObject(fp.twilio) ? fp.twilio : {};
  const adminKey =
    typeof fp.admin_password_vault_key === "string" && fp.admin_password_vault_key.trim()
      ? fp.admin_password_vault_key.trim()
      : "HDC_FREEPBX_ADMIN_PASSWORD";
  const debianKey =
    typeof fp.debian_password_vault_key === "string" && fp.debian_password_vault_key.trim()
      ? fp.debian_password_vault_key.trim()
      : "HDC_FREEPBX_DEBIAN_PASSWORD";
  const userKey =
    typeof twilio.credential_username_vault_key === "string"
      ? twilio.credential_username_vault_key.trim()
      : "HDC_TWILIO_SIP_USERNAME";
  const passKey =
    typeof twilio.credential_password_vault_key === "string"
      ? twilio.credential_password_vault_key.trim()
      : "HDC_TWILIO_SIP_PASSWORD";

  const deps = createNodeCliDeps();
  const vaultAccess = createFreepbxVaultAccess(deps);
  const secrets = {
    adminPassword: await resolveOrCreateSecret(vaultAccess, adminKey, { generate: true }),
    debianPassword: await resolveOrCreateSecret(vaultAccess, debianKey, { generate: true }),
    sipUsername: await resolveOrCreateSecret(vaultAccess, userKey),
    sipPassword: await resolveOrCreateSecret(vaultAccess, passKey),
  };
  logLine(`vault keys ready (${adminKey} generated if missing; Twilio keys required)`);

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let allOk = true;
  for (const d of deployments) {
    try {
      const r = await deployOne(d, norm.defaults, fp, secrets, flags, log, vaultAccess);
      results.push(r);
      if (!r.ok) allOk = false;
    } catch (e) {
      allOk = false;
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${d.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: d.systemId, message: msg });
    }
  }

  const payload = { ok: allOk, target, verb, count: results.length, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok: allOk,
    log: logLine,
  });
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
