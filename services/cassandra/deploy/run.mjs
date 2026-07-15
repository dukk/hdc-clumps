#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Deploy Apache Cassandra 3-node cluster on Proxmox QEMU or configure-only.
 *
 * Usage: hdc run service cassandra deploy -- [--instance a|b|c] [--destroy-existing] [--skip-provision]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { ensureQemuGuestAgentOnDeploy } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-install.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { createCassandraVaultAccess } from "hdc/package/vault-deps.mjs";
import {
  cassandraGlobalSettings,
  normalizeCassandraConfig,
  resolveCassandraDeployments,
} from "hdc/package/deployments.mjs";
import {
  configureCassandra,
  createConfigureExec,
  setupSuperuserPassword,
  waitForCassandraReady,
} from "hdc/package/cassandra-configure.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  waitForQemuGuestSshAfterBoot,
} from "hdc/package/proxmox-qemu-redeploy.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";

import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/cassandra/config.example.json";
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
 * @param {Record<string, string>} flags
 */
function destroyPolicy(flags) {
  return flagGet(flags, "destroy-existing") !== undefined;
}

/**
 * @param {Record<string, string>} flags
 */
function skipProvision(flags) {
  return flagGet(flags, "skip-provision") !== undefined;
}

/**
 * @param {Record<string, string>} flags
 */
function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  if (destroyPolicy(flags)) return "destroy";
  return "prompt";
}

/**
 * @param {ReturnType<typeof import("../lib/deployments.mjs").resolveCassandraDeployments>[number]} deployment
 */
function sshFromDeployment(deployment) {
  const cfg = deployment.configure;
  const ssh = isObject(cfg) && isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  const host =
    typeof ssh.host === "string" && ssh.host.trim()
      ? ssh.host.trim()
      : deployment.listenIp;
  if (!host) {
    throw new Error(`${deployment.systemId}: configure.ssh.host or listen IP required`);
  }
  return { user, host };
}

/**
 * @param {ReturnType<typeof import("../lib/deployments.mjs").resolveCassandraDeployments>[number]} deployment
 * @param {ReturnType<typeof cassandraGlobalSettings>} global
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {boolean} [skipInstall]
 */
function runConfigure(deployment, global, log, skipInstall = false) {
  const { user, host } = sshFromDeployment(deployment);
  const exec = createConfigureExec("ssh", { user, host });
  const rack = deployment.rack || global.rack;
  configureCassandra({
    exec,
    log,
    clusterName: global.clusterName,
    seedIps: global.seedIps,
    listenIp: deployment.listenIp || host,
    datacenter: global.datacenter,
    rack,
    version: global.version,
    memoryMb: deployment.memoryMb || global.defaultMemoryMb,
    passwordAuthEnabled: global.passwordAuthEnabled,
    skipInstall,
  });
  return { user, host, exec };
}

/**
 * @param {ReturnType<typeof import("../lib/deployments.mjs").resolveCassandraDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof cassandraGlobalSettings>} global
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
async function deployOne(deployment, flags, global, log) {
  const inv = deployTargetInventory(root, target, { systemIdOverride: deployment.systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (skipProvision(flags) || deployment.mode === "configure-only") {
    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} configure-only …\n`);
    const { host, exec } = runConfigure(deployment, global, log);
    const ready = await waitForCassandraReady({
      exec,
      listenIp: deployment.listenIp || host,
      onProgress: (m) => errout.write(`[hdc] ${target} ${verb}: ${m}\n`),
    });
    return {
      ok: ready.ok,
      system_id: deployment.systemId,
      mode: "configure-only",
      ready,
    };
  }

  const px = deployment.proxmox;
  if (!isObject(px)) {
    return { ok: false, system_id: deployment.systemId, message: "missing proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: deployment.systemId, message: "missing host_id" };
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
    (typeof q.name === "string" && q.name.trim() ? q.name.trim() : deployment.systemId.replace(/^vm-/, ""));

  if (!Number.isFinite(vmid) || vmid <= 0 || !Number.isFinite(templateVmid) || templateVmid <= 0 || !ip) {
    return { ok: false, system_id: deployment.systemId, message: "invalid qemu vmid, template_vmid, or ip" };
  }

  errout.write(
    `[hdc] ${target} ${verb}: ${deployment.systemId} (seed=${deployment.seed}) on ${hostId} vmid ${vmid} …\n`,
  );
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await locateGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  const policy = existingGuestPolicy(flags);

  if (located) {
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(
        deployment.systemId,
        vmid,
        located.node,
        located.name,
      );
    }
    if (action === "skip") {
      errout.write(`[hdc] ${target} ${verb}: skipping provision for ${deployment.systemId}.\n`);
      return { ok: true, system_id: deployment.systemId, skipped_provision: true };
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
      const { host, exec } = runConfigure(deployment, global, log, true);
      const ready = await waitForCassandraReady({
        exec,
        listenIp: deployment.listenIp || host,
        onProgress: (m) => errout.write(`[hdc] ${target} ${verb}: ${m}\n`),
      });
      return {
        ok: ready.ok,
        system_id: deployment.systemId,
        skipped_provision: true,
        ready,
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
      system_id: deployment.systemId,
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

  const sshHost = ip.split("/")[0];
  const sshCfg = isObject(deployment.configure) && isObject(deployment.configure.ssh)
    ? deployment.configure.ssh
    : {};
  let sshUser = resolveGuestSshUser(sshCfg.user);

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

  const depWithSsh = {
    ...deployment,
    listenIp: sshHost,
    configure: { ssh: { user: sshUser, host: sshHost } },
  };
  const { host, exec } = runConfigure(depWithSsh, global, log);
  const ready = await waitForCassandraReady({
    exec,
    listenIp: depWithSsh.listenIp || host,
    onProgress: (m) => errout.write(`[hdc] ${target} ${verb}: ${m}\n`),
  });

  return {
    ok: ready.ok,
    system_id: deployment.systemId,
    seed: deployment.seed,
    provision: provisionResult,
    ready,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Cassandra cluster (stderr log; JSON on stdout).\n`);

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
  let normalized;
  let deployments;
  try {
    normalized = normalizeCassandraConfig(cfg);
    deployments = resolveCassandraDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const global = cassandraGlobalSettings(normalized, deployments);
  let superuserPassword = "";

  if (global.passwordAuthEnabled) {
    const vault = createCassandraVaultAccess();
    errout.write(
      `[hdc] ${target} ${verb}: loading superuser password from vault key ${global.superuserVaultKey} …\n`,
    );
    await vault.unlock({});
    superuserPassword = String(
      await vault.getSecret(global.superuserVaultKey, {
        promptLabel: `vault secret ${global.superuserVaultKey}`,
      }),
    ).trim();
    if (!superuserPassword) {
      errout.write(
        `[hdc] ${target} ${verb}: password empty — hdc secrets set ${global.superuserVaultKey}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({ ok: false, target, verb, message: "missing superuser password" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (global.seedIps.length < 2) {
    errout.write(`[hdc] ${target} ${verb}: warning — fewer than 2 seed IPs; recommend two seed nodes.\n`);
  }

  if (deployments.length > 1) {
    errout.write(
      `[hdc] ${target} ${verb}: deploying ${deployments.length} node(s) in bootstrap order (seeds first) …\n`,
    );
  }

  const log = provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await deployOne(deployment, flags, global, log));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const allProvisioned = results.every((r) => r.ok);
  if (allProvisioned && global.passwordAuthEnabled && superuserPassword) {
    const seedDep = deployments.find((d) => d.seed) ?? deployments[0];
    const { user, host } = sshFromDeployment(seedDep);
    const exec = createConfigureExec("ssh", { user, host });
    errout.write(`[hdc] ${target} ${verb}: setting cassandra superuser password on seed ${host} …\n`);
    try {
      const authResult = setupSuperuserPassword({
        exec,
        password: superuserPassword,
        log: (m) => errout.write(`[hdc] ${target} ${verb}: ${m}\n`),
      });
      results.push({ step: "superuser_password", ok: authResult.ok, host });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: superuser setup failed: ${msg}\n`);
      results.push({ step: "superuser_password", ok: false, message: msg });
    }
  }

  const ok = results.every((r) => r.ok !== false);
  const payload = {
    ok,
    target,
    verb,
    cluster_name: global.clusterName,
    seed_ips: global.seedIps,
    count: results.length,
    results,
  };
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

