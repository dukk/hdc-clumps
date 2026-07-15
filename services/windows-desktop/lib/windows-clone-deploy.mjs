import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import {
  createProxmoxHostProvisioner,
  fetchClusterVmResources,
  locateVmidInCluster,
} from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";
import {
  allocateNextVmid,
  cloneQemuGuest,
  locateGuest,
  stopAndDestroyQemu,
} from "../../bind/lib/proxmox-qemu-redeploy.mjs";

import {
  autounattendIsoBasename,
  buildAndUploadAutounattendIso,
} from "./autounattend-iso.mjs";
import {
  adminUsername,
  localeId,
  resolveTemplateConfig,
} from "./deployments.mjs";
import { ensureOemLicenseForVm } from "./oem-apply.mjs";
import { promptExistingGuestAction } from "./prompt-existing.mjs";
import {
  attachAutounattendIso,
  detachInstallIsos,
  startQemuGuest,
  waitForWindowsInstallWindow,
} from "./proxmox-windows-vm.mjs";
import {
  assertNoProductKeyInUnattend,
  renderAutounattendCloneXml,
} from "./windows-unattend.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("./deployments.mjs").normalizeWindowsDesktopConfig>} opts.normalized
 * @param {ReturnType<typeof import("./deployments.mjs").resolveWindowsDesktopDeployments>[number]} opts.deployment
 * @param {string} opts.adminPassword
 * @param {Record<string, string>} opts.flags
 * @param {string} opts.proxmoxRoot
 * @param {string} opts.repoRoot
 * @param {string} opts.target
 * @param {string} opts.verb
 * @param {number} opts.installTimeoutMinutes
 * @param {(line: string) => void} opts.log
 */
export async function deployWindowsCloneInstance(opts) {
  const {
    normalized,
    deployment,
    adminPassword,
    flags,
    proxmoxRoot,
    repoRoot,
    target,
    verb,
    installTimeoutMinutes,
    log,
  } = opts;

  const inv = deployTargetInventory(repoRoot, target, { systemIdOverride: deployment.systemId });
  logDeployInventoryStatus(target, verb, inv);

  const templateCfg = resolveTemplateConfig(normalized);
  const px = deployment.proxmox;
  const hostId = px.hostId;
  const q = px.qemu;
  const net = px.network;
  const oem = px.oem;

  log(`${deployment.systemId} on ${hostId} (proxmox-qemu-clone) …`);

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const node = auth.host.pveNode;
  const resources = await fetchClusterVmResources(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );

  const templateGuest = locateVmidInCluster(resources, templateCfg.vmid);
  if (!templateGuest) {
    throw new Error(
      `template vmid ${templateCfg.vmid} not found — run deploy with --build-template first`,
    );
  }
  if (templateGuest.node !== node) {
    throw new Error(
      `template vmid ${templateCfg.vmid} is on ${templateGuest.node}, expected ${node}`,
    );
  }

  let vmid = typeof q.vmid === "number" && Number.isFinite(q.vmid) && q.vmid > 0 ? q.vmid : null;
  if (!vmid) {
    vmid = allocateNextVmid(resources, 200);
    log(`auto-allocated vmid ${vmid}.`);
  }

  const destroyExisting = flags["destroy-existing"] !== undefined;
  const skipExisting = flags["skip-existing"] !== undefined;
  const redeployExisting = flags["redeploy-existing"] !== undefined;

  const located = await locateGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );
  if (located) {
    let action = destroyExisting ? "destroy" : skipExisting ? "skip" : redeployExisting ? "redeploy" : "prompt";
    if (action === "prompt") {
      action = await promptExistingGuestAction(
        deployment.systemId,
        vmid,
        located.node,
        located.name,
      );
    }
    if (action === "skip") {
      log(`skipping ${deployment.systemId} (vmid ${vmid} exists).`);
      return { ok: true, system_id: deployment.systemId, skipped: true, vmid };
    }
    if (action === "destroy" || destroyExisting) {
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log,
      });
    } else {
      return {
        ok: false,
        system_id: deployment.systemId,
        message: "guest exists — use --destroy-existing to rebuild",
        vmid,
      };
    }
  }

  const provisioner = createProxmoxHostProvisioner({
    apiBase: auth.host.apiBase,
    node,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    clumpId: target,
  });

  const cloneResult = await cloneQemuGuest({
    log,
    provisioner,
    name: deployment.hostname,
    vmid,
    templateVmid: templateCfg.vmid,
    parameters: {
      full: 1,
      storage: typeof q.storage === "string" ? q.storage.trim() : "local-lvm",
    },
  });

  if (!cloneResult.ok) {
    throw new Error(cloneResult.message || "QEMU clone failed");
  }

  await waitForCloneTaskAndEnableAgent(cloneResult, auth, vmid, log);

  const deps = createNodeCliDeps();
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const sshTarget = { id: hostId, host: pveSsh.host, user: pveSsh.user, clusterId: null };
  const { identities } = discoverLocalSshMaterial();

  if (flags["skip-oem"] === undefined && oem.enabled !== false && oem.enabled !== 0) {
    await ensureOemLicenseForVm({
      sshTarget,
      pveNode: node,
      apiBase: auth.host.apiBase,
      node,
      vmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      spawnSync: deps.spawnSync,
      env: deps.env,
      requireFirmware: oem.require_firmware !== false && oem.require_firmware !== 0,
      log,
      warn: (line) => log(`WARN ${line}`),
    });
  } else {
    log("OEM passthrough skipped.");
  }

  const isoStorage =
    (typeof q.iso_storage === "string" && q.iso_storage.trim()) ||
    "local";

  const xml = renderAutounattendCloneXml({
    computerName: deployment.hostname,
    adminUsername: adminUsername(deployment),
    adminPassword,
    locale: localeId(deployment),
    network:
      typeof q.ip === "string" && q.ip.trim() && typeof net.gateway === "string"
        ? {
            ipCidr: q.ip.trim(),
            gateway: net.gateway.trim(),
            dnsServers: Array.isArray(net.dns) ? net.dns.map(String) : [],
          }
        : undefined,
  });
  assertNoProductKeyInUnattend(xml);

  const autounattendVolid = await buildAndUploadAutounattendIso({
    sshTarget,
    xml,
    isoStorage,
    basename: autounattendIsoBasename(deployment.systemId),
    spawnSync: deps.spawnSync,
    env: deps.env,
    identities,
    log,
  });

  await attachAutounattendIso({
    apiBase: auth.host.apiBase,
    node,
    vmid,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    autounattendIsoVolid: autounattendVolid,
    log,
  });

  /** @type {{ install_wait?: Record<string, unknown> }} */
  const extra = {};

  if (flags["skip-install"] === undefined) {
    await startQemuGuest({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node,
      vmid,
      log,
    });

    if (flags["wait-install"] !== undefined) {
      extra.install_wait = await waitForWindowsInstallWindow({
        apiBase: auth.host.apiBase,
        node,
        vmid,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        timeoutMs: installTimeoutMinutes * 60_000,
        log,
      });
    }

    await detachInstallIsos({
      apiBase: auth.host.apiBase,
      node,
      vmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      log,
    });
  } else {
    log("Clone created but not started (--skip-install).");
  }

  return {
    ok: true,
    system_id: deployment.systemId,
    host_id: hostId,
    vmid,
    node,
    hostname: deployment.hostname,
    template_vmid: templateCfg.vmid,
    mode: "proxmox-qemu-clone",
    autounattend_volid: autounattendVolid,
    ...extra,
  };
}
