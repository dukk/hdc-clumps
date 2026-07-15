#!/usr/bin/env node
/**
 * Deploy Mailcow on Proxmox LXC or QEMU (mailcow-dockerized).
 *
 * Usage: hdc run service mailcow deploy -- [--instance a | --system-id vm-mailcow-a] [--skip-install]
 *        hdc run service mailcow deploy -- [--skip-existing | --redeploy-existing | --destroy-existing]
 *        hdc run service mailcow deploy -- [--skip-provision] [--skip-domains] [--skip-cloudflare-dkim] [--skip-mailboxes] [--skip-aliases] [--prune]
 */
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { lxcHostnameFromSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForLxcCreateTaskAndApplyResources } from "../../../infrastructure/proxmox/lib/proxmox-lxc-post-create.mjs";
import { ensureLxcStarted } from "../../../infrastructure/proxmox/lib/proxmox-lxc-start.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { resolveProvisionVmid } from "../../../infrastructure/proxmox/lib/proxmox-vmid-conflict.mjs";
import { ensureQemuGuestAgentOnDeploy } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-install.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import {
  dataDiskGbFromDeployment,
  dataDiskStorageFromDeployment,
  resolveMailcowDeployments,
} from "hdc/package/deployments.mjs";
import { findClusterGuest } from "hdc/package/guest-exists.mjs";
import {
  installMailcowInCt,
  installMailcowOnHost,
  readCtPrimaryIp,
  resolvePveSshForHost,
} from "hdc/package/mailcow-install.mjs";
import { reconcileMailcowDomainsForConfig } from "hdc/package/mailcow-domains.mjs";
import { reconcileMailcowMailboxesForConfig } from "hdc/package/mailcow-mailboxes.mjs";
import { resolveAdminUrl } from "hdc/package/mailcow-render.mjs";
import { attachQemuDataDisk } from "hdc/package/proxmox-data-disk.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  waitForQemuGuestSshAfterBoot,
} from "hdc/package/proxmox-qemu-redeploy.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { createMailcowVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolveMailcowDbSecrets } from "hdc/package/vault-secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/mailcow/config.example.json";
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
 * @param {Record<string, unknown>} install
 */
function shouldInstall(install) {
  return install.enabled !== false;
}

/**
 * @param {Record<string, string>} flags
 */
function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  if (flagGet(flags, "destroy-existing") !== undefined) return "destroy";
  return "prompt";
}

/**
 * @param {Record<string, string>} flags
 */
function skipProvision(flags) {
  return flagGet(flags, "skip-provision") !== undefined;
}

/**
 * @param {ReturnType<typeof resolveMailcowDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {{ dbpass: string; dbroot: string; redispass: string }} dbSecrets
 */
async function runConfigure(deployment, flags, dbSecrets) {
  const { systemId, mode, mailcow, install, configure } = deployment;
  const mailcowCfg = isObject(mailcow) ? mailcow : {};
  const installCfg = isObject(install) ? install : {};

  if (!shouldInstall(installCfg)) {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} install disabled — skipping configure.\n`);
    return { ok: true, skipped: true, message: "install disabled" };
  }

  if (mode === "proxmox-lxc") {
    const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    return installMailcowInCt(pveSsh.user, pveSsh.host, vmid, mailcowCfg, installCfg, dbSecrets);
  }

  const cfg = isObject(configure) ? configure : {};
  const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
  if (!host) {
    throw new Error(`${systemId}: configure.ssh.host required`);
  }
  const exec = createConfigureExec("ssh", { user, host });
  const dataDiskGb = dataDiskGbFromDeployment(deployment);
  return installMailcowOnHost(exec, mailcowCfg, installCfg, dbSecrets, dataDiskGb);
}

/**
 * @param {ReturnType<typeof resolveMailcowDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null }; dbSecrets: { dbpass: string; dbroot: string; redispass: string } }} runOpts
 */
async function deployLxcOne(deployment, flags, log, runOpts) {
  const { mode, systemId, proxmox: px, mailcow, install } = deployment;

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: ${JSON.stringify(systemId)} on ${JSON.stringify(hostId)} mode ${JSON.stringify(mode)} …\n`,
  );
  errout.write(`[hdc] ${target} ${verb}: authorizing Proxmox API for host ${JSON.stringify(hostId)} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });

  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  const located = await findClusterGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );

  let skipProvisionLocal = false;
  if (located) {
    const policy = existingGuestPolicy(flags);
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    }
    if (action === "skip") {
      errout.write(`[hdc] ${target} ${verb}: skipping ${systemId} (vmid ${vmid} already exists).\n`);
      return {
        ok: true,
        system_id: systemId,
        host_id: hostId,
        mode,
        skipped: true,
        message: "guest already exists",
        guest: { vmid, node: located.node, name: located.name },
      };
    }
    errout.write(
      `[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} exists — redeploy (provision skipped, install only).\n`,
    );
    skipProvisionLocal = true;
  }

  /** @type {import("../../../lib/host-provisioner.mjs").ProvisionResult | null} */
  let provisionResult = null;

  if (!skipProvisionLocal) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,    });
    const hostname =
      (typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
      lxcHostnameFromSystemId(systemId) ||
      "mailcow";
    const memoryMb = typeof lxc.memory_mb === "number" ? lxc.memory_mb : Number(lxc.memory_mb);
    const cores = typeof lxc.cores === "number" ? lxc.cores : Number(lxc.cores);
    const diskGb = typeof lxc.rootfs_gb === "number" ? lxc.rootfs_gb : Number(lxc.rootfs_gb);
    if (![memoryMb, cores, diskGb].every((n) => Number.isFinite(n) && n > 0)) {
      return { ok: false, system_id: systemId, host_id: hostId, message: "invalid lxc sizing fields" };
    }
    const cache = runOpts.ctPasswordCache ?? { value: null };
    let rootPassword;
    try {
      rootPassword = await resolveLxcRootPassword(systemId, vmid, lxc, flags, {
        cached: cache.value,
        setCached: (v) => {
          cache.value = v;
        },
      });
    } catch (e) {
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        message: String(/** @type {Error} */ (e).message || e),
      };
    }
    /** @type {Record<string, unknown>} */
    const parameters = { ...lxc, password: rootPassword };
    provisionResult = await prov.createContainer(log, {
      name: hostname,
      memoryMb,
      cores,
      diskGb,
      parameters,
    });
    if (!provisionResult.ok) {
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
      };
    }
  } else {
    provisionResult = {
      ok: true,
      message: `LXC ${vmid} already present on ${located?.node ?? "?"}`,
      details: { vmid, node: located?.node, type: "lxc", skipped_provision: true },
    };
  }

  const guestVmid = resolveProvisionVmid(provisionResult, vmid);
  const lxcNode =
    (typeof provisionResult.details?.node === "string" && provisionResult.details.node.trim()) ||
    located?.node ||
    auth.host.pveNode;

  await waitForLxcCreateTaskAndApplyResources(
    provisionResult,
    auth,
    vmid,
    (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    guestResourceOptsFromBlock(lxc, flags),
  );

  const mailcowCfg = isObject(mailcow) ? mailcow : {};
  const installCfg = isObject(install) ? install : {};

  if (shouldInstall(installCfg)) {
    try {
      await ensureLxcStarted({
        apiBase: auth.host.apiBase,
        node: lxcNode,
        vmid: guestVmid,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      return {
        ok: false,
        system_id: systemId,
        host_id: hostId,
        mode,
        result: provisionResult,
        message: msg,
      };
    }
  }

  let installResult = { ok: true, method: "skipped", message: "skipped" };
  if (shouldInstall(installCfg)) {
    installResult = await runConfigure(deployment, flags, runOpts.dbSecrets);
  } else {
    errout.write(`[hdc] ${target} ${verb}: install skipped for ${systemId}.\n`);
  }

  if (!installResult.ok) {
    return {
      ok: false,
      system_id: systemId,
      host_id: hostId,
      mode,
      redeploy: skipProvisionLocal,
      result: provisionResult,
      install: installResult,
    };
  }

  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const ip = readCtPrimaryIp(pveSsh.user, pveSsh.host, guestVmid);

  return {
    ok: provisionResult.ok && installResult.ok,
    system_id: systemId,
    host_id: hostId,
    mode,
    redeploy: skipProvisionLocal,
    ip,
    admin_url: resolveAdminUrl(mailcowCfg),
    result: provisionResult,
    install: installResult,
  };
}

/**
 * @param {ReturnType<typeof resolveMailcowDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ dbpass: string; dbroot: string; redispass: string }} dbSecrets
 */
async function deployQemuOne(deployment, flags, log, dbSecrets) {
  const { systemId, mailcow, install } = deployment;

  if (skipProvision(flags) || deployment.mode === "configure-only") {
    errout.write(`[hdc] ${target} ${verb}: ${systemId} configure-only …\n`);
    const configure = await runConfigure(deployment, flags, dbSecrets);
    return { ok: configure.ok !== false, system_id: systemId, mode: deployment.mode, configure };
  }

  const px = deployment.proxmox;
  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "missing proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }
  const q = isObject(px.qemu) ? px.qemu : {};
  const net = isObject(px.network) ? px.network : {};
  const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
  const templateVmid = typeof q.template_vmid === "number" ? q.template_vmid : Number(q.template_vmid);
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const gateway =
    typeof net.gateway === "string" && net.gateway.trim()
      ? net.gateway.trim()
      : typeof q.gateway === "string"
        ? q.gateway.trim()
        : "192.0.2.1";
  const hostname =
    deployment.hostname ||
    (typeof q.name === "string" && q.name.trim() ? q.name.trim() : systemId.replace(/^vm-/, ""));
  const dataDiskGb = dataDiskGbFromDeployment(deployment);
  const dataDiskStorage = dataDiskStorageFromDeployment(deployment);
  const rootfsGb = typeof q.rootfs_gb === "number" ? q.rootfs_gb : Number(q.rootfs_gb);

  if (!Number.isFinite(vmid) || vmid <= 0 || !Number.isFinite(templateVmid) || templateVmid <= 0 || !ip) {
    return { ok: false, system_id: systemId, message: "invalid qemu vmid, template_vmid, or ip" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${hostId} vmid ${vmid} (QEMU) …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await locateGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  const policy = existingGuestPolicy(flags);

  if (located) {
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    }
    if (action === "skip") {
      errout.write(`[hdc] ${target} ${verb}: skipping provision for ${systemId}.\n`);
      return { ok: true, system_id: systemId, skipped_provision: true };
    }
    if (action === "destroy" || policy === "destroy") {
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
    } else {
      errout.write(
        `[hdc] ${target} ${verb}: guest exists — configure only (use --destroy-existing to rebuild).\n`,
      );
      const configure = await runConfigure(deployment, flags, dbSecrets);
      return {
        ok: configure.ok !== false,
        system_id: systemId,
        skipped_provision: true,
        configure,
        admin_url: resolveAdminUrl(isObject(mailcow) ? mailcow : {}),
      };
    }
  }

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
    name: hostname,
    vmid,
    templateVmid,
    parameters: { ...q, vmid, template_vmid: templateVmid },
  });

  if (!provisionResult.ok) {
    return {
      ok: false,
      system_id: systemId,
      provision: provisionResult,
    };
  }

  const { node: cloneNode, vmid: guestVmid } = await waitForCloneTaskAndEnableAgent(
    provisionResult,
    auth,
    vmid,
    (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    guestResourceOptsFromBlock(q, flags),
  );

  if (Number.isFinite(rootfsGb) && rootfsGb > 0) {
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    errout.write(`[hdc] ${target} ${verb}: resizing scsi0 to ${rootfsGb}G on vmid ${guestVmid} …\n`);
    const resize = sshRemote(pveSsh.user, pveSsh.host, `qm resize ${guestVmid} scsi0 ${rootfsGb}G`, {
      capture: true,
    });
    if (resize.status !== 0) {
      const detail = `${resize.stderr}${resize.stdout}`.trim() || `exit ${resize.status}`;
      throw new Error(`qm resize failed: ${detail}`);
    }
  }

  if (dataDiskGb > 0) {
    await attachQemuDataDisk({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: cloneNode,
      vmid: guestVmid,
      storage: dataDiskStorage,
      sizeGb: dataDiskGb,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
  }

  await applyQemuCloudInit({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: cloneNode,
    vmid: guestVmid,
    hostname,
    ipCidr: ip,
    gateway,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  await startQemuGuest({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: cloneNode,
    vmid: guestVmid,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  const sshCfg = isObject(deployment.configure) && isObject(deployment.configure.ssh)
    ? deployment.configure.ssh
    : {};
  let sshUser = resolveGuestSshUser(sshCfg.user);
  const sshHost = typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];

  const sshWait = await waitForQemuGuestSshAfterBoot({
    user: sshUser,
    host: sshHost,
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: cloneNode,
    vmid: guestVmid,
    freshClone: true,
    proxmoxPackageRoot: proxmoxRoot,
    flags,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
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
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  const configure = await runConfigure(
    {
      ...deployment,
      configure: { ssh: { user: sshUser, host: sshHost } },
    },
    flags,
    dbSecrets,
  );

  const mailcowCfg = isObject(mailcow) ? mailcow : {};
  return {
    ok: configure.ok !== false,
    system_id: systemId,
    mode: "proxmox-qemu",
    ip: sshHost,
    admin_url: resolveAdminUrl(mailcowCfg),
    provision: provisionResult,
    configure,
  };
}

/**
 * @param {ReturnType<typeof resolveMailcowDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ ctPasswordCache?: { value: string | null }; dbSecrets: { dbpass: string; dbroot: string; redispass: string } }} runOpts
 */
/**
 * @param {Record<string, unknown>} result
 * @param {ReturnType<typeof resolveMailcowDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof createMailcowVaultAccess>} vault
 */
async function applyDomainReconciliationAfterDeploy(result, deployment, flags, vault) {
  if (result.ok === false) return result;

  const skipDomains = flagGet(flags, "skip-domains", "skip_domains") !== undefined;
  const skipCloudflareDkim =
    flagGet(flags, "skip-cloudflare-dkim", "skip_cloudflare_dkim") !== undefined;
  const skipMailboxes = flagGet(flags, "skip-mailboxes", "skip_mailboxes") !== undefined;
  const skipAliases = flagGet(flags, "skip-aliases", "skip_aliases") !== undefined;
  const prune = flagGet(flags, "prune") !== undefined;
  const mailcowCfg = isObject(deployment.mailcow) ? deployment.mailcow : {};
  const reconcileLog = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
  const apiKey = await resolveMailcowApiKey(vault, mailcowCfg, { required: false });

  const domainReconcile = await reconcileMailcowDomainsForConfig(mailcowCfg, vault, {
    skipDomains,
    skipCloudflareDkim,
    apiKey,
    log: reconcileLog,
  });
  const mailboxReconcile = await reconcileMailcowMailboxesForConfig(mailcowCfg, vault, {
    skipMailboxes,
    skipAliases,
    prune,
    apiKey,
    log: reconcileLog,
  });

  const domainResults = domainReconcile.domain_results;
  const domainsOk = domainReconcile.domains_skipped
    ? true
    : domainReconcile.api_ok === false
      ? false
      : domainResults.every((r) => r.ok !== false);
  const mailboxesOk =
    mailboxReconcile.mailboxes_skipped && mailboxReconcile.aliases_skipped
      ? true
      : mailboxReconcile.api_ok === false
        ? false
        : mailboxReconcile.mailbox_results.every((r) => r.ok !== false) &&
          mailboxReconcile.alias_results.every((r) => r.ok !== false);
  const cloudflareDkimOk =
    !domainReconcile.cloudflare_dkim ||
    domainReconcile.cloudflare_dkim.skipped === true ||
    domainReconcile.cloudflare_dkim.ok !== false;

  return {
    ...result,
    ok: result.ok !== false && domainsOk && mailboxesOk && cloudflareDkimOk,
    skip_domains: skipDomains,
    skip_cloudflare_dkim: skipCloudflareDkim,
    skip_mailboxes: skipMailboxes,
    skip_aliases: skipAliases,
    prune,
    domains_skipped: domainReconcile.domains_skipped,
    mailboxes_skipped: mailboxReconcile.mailboxes_skipped,
    aliases_skipped: mailboxReconcile.aliases_skipped,
    configured_domain_count: domainReconcile.configured_domain_count,
    configured_mailbox_count: mailboxReconcile.configured_mailbox_count,
    configured_alias_count: mailboxReconcile.configured_alias_count,
    api_ok: domainReconcile.api_ok,
    api_error: domainReconcile.api_error,
    mailbox_api_ok: mailboxReconcile.api_ok,
    mailbox_api_error: mailboxReconcile.api_error,
    reconcile_summary: domainReconcile.reconcile_summary,
    mailbox_reconcile_summary: mailboxReconcile.mailbox_reconcile_summary,
    alias_reconcile_summary: mailboxReconcile.alias_reconcile_summary,
    cloudflare_dkim: domainReconcile.cloudflare_dkim,
    domain_results: domainResults,
    mailbox_results: mailboxReconcile.mailbox_results,
    alias_results: mailboxReconcile.alias_results,
    dns_checklists: domainReconcile.dns_checklists,
  };
}

async function deployOne(deployment, flags, log, runOpts) {
  const inv = deployTargetInventory(root, target, { systemIdOverride: deployment.systemId });
  logDeployInventoryStatus(target, verb, inv);

  const vault = createMailcowVaultAccess();
  /** @type {Record<string, unknown>} */
  let result;
  if (deployment.mode === "proxmox-qemu" || deployment.mode === "configure-only") {
    result = await deployQemuOne(deployment, flags, log, runOpts.dbSecrets);
  } else if (deployment.mode === "proxmox-lxc") {
    result = await deployLxcOne(deployment, flags, log, runOpts);
  } else {
    return { ok: false, system_id: deployment.systemId, message: `unsupported mode ${deployment.mode}` };
  }

  return applyDomainReconciliationAfterDeploy(result, deployment, flags, vault);
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Mailcow via Proxmox (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    const inv = deployTargetInventory(root, target);
    logDeployInventoryStatus(target, verb, inv);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  /** @type {ReturnType<typeof resolveMailcowDeployments>} */
  let deployments;
  try {
    deployments = resolveMailcowDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createMailcowVaultAccess();
  const defaultsMc =
    isObject(cfg.defaults) && isObject(cfg.defaults.mailcow) ? cfg.defaults.mailcow : {};
  errout.write(`[hdc] ${target} ${verb}: resolving DB secrets from vault …\n`);
  const dbSecrets = await resolveMailcowDbSecrets(vault, defaultsMc);

  const log = provisionLogFromConsole(console);
  /** @type {{ value: string | null }} */
  const ctPasswordCache = { value: null };
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await deployOne(deployment, flags, log, { ctPasswordCache, dbSecrets }));
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
