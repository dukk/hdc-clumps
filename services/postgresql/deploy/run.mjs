#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Deploy PostgreSQL on Proxmox QEMU (standalone, primary, or standby).
 *
 * Usage: hdc run service postgresql deploy -- [--instance a | --system-id vm-postgres-a]
 *        [--destroy-existing] [--skip-provision] [--skip-install]
 *        [--skip-existing | --redeploy-existing]
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
import {
  configurePostgresqlServer,
  configurePostgresqlStandby,
  createConfigureExec,
} from "hdc/package/postgresql-configure.mjs";
import {
  databasesForDeployment,
  findPrimaryDeployment,
  hasStandbyDeployments,
  normalizePostgresqlConfig,
  postgresqlGlobalSettings,
  resolvePostgresqlDeployments,
  rolesForDeployment,
  sshHostFromDeployment,
} from "hdc/package/deployments.mjs";
import { instanceLetterFromSystemId, replicationPasswordVaultKey, superuserPasswordVaultKey } from "hdc/package/inventory.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  waitForQemuGuestSshAfterBoot,
} from "hdc/package/proxmox-qemu-redeploy.mjs";
import { createPostgresqlVaultAccess } from "hdc/package/vault-deps.mjs";
import { postgresqlReportExtraSections } from "hdc/package/postgresql-report.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/postgresql/config.example.json";
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
 * @param {ReturnType<typeof resolvePostgresqlDeployments>} allDeployments
 * @param {ReturnType<typeof resolvePostgresqlDeployments>[number]} primaryDeployment
 */
function standbyIpsForPrimary(allDeployments, primaryDeployment) {
  return allDeployments
    .filter(
      (d) =>
        d.role === "standby" && d.primarySystemId === primaryDeployment.systemId,
    )
    .map((d) => sshHostFromDeployment(d))
    .filter(Boolean);
}

/**
 * @param {object} ctx
 */
async function runConfigure(ctx) {
  const {
    deployment,
    allDeployments,
    global,
    superuserPassword,
    replicationPassword,
    vault,
    log,
  } = ctx;

  if (deployment.install.enabled === false) {
    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} install disabled — skipping configure.\n`);
    return { ok: true, skipped: true, message: "install disabled" };
  }

  const cfg = deployment.configure;
  const ssh = isObject(cfg) && isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
  if (!host) {
    throw new Error(`${deployment.systemId}: configure.ssh.host required`);
  }
  const exec = createConfigureExec("ssh", { user, host });

  if (deployment.role === "standby") {
    const primary = findPrimaryDeployment(allDeployments, deployment.primarySystemId);
    if (!primary) {
      throw new Error(`${deployment.systemId}: primary ${deployment.primarySystemId} not in deployment set`);
    }
    const primaryHost = sshHostFromDeployment(primary);
    if (!primaryHost) {
      throw new Error(`${deployment.systemId}: primary has no configure.ssh.host`);
    }
    if (!replicationPassword) {
      throw new Error("replication password required for standby deploy");
    }
    return configurePostgresqlStandby({
      exec,
      log,
      versionMajor: global.versionMajor,
      primaryHost,
      replicationUser: global.replicationUser,
      replicationPassword,
    });
  }

  const replicationEnabled =
    deployment.role === "primary" && hasStandbyDeployments(allDeployments);
  const standbyHostIps =
    deployment.role === "primary"
      ? standbyIpsForPrimary(allDeployments, deployment)
      : [];

  const resolveRolePassword = async (key, label) => {
    errout.write(`[hdc] ${target} ${verb}: loading role password ${key} for ${label} …\n`);
    return String(await vault.getSecret(key, { promptLabel: `vault secret ${key}` })).trim();
  };

  return configurePostgresqlServer({
    exec,
    log,
    versionMajor: global.versionMajor,
    superuserPassword,
    listenCidrs: global.listenCidrs,
    listenAddresses: global.listenAddresses,
    replicationEnabled,
    replicationUser: global.replicationUser,
    replicationPassword: replicationEnabled ? replicationPassword : "",
    standbyHostIps,
    databases: databasesForDeployment(global, deployment),
    roles: rolesForDeployment(global, deployment),
    resolveRolePassword: rolesForDeployment(global, deployment).length ? resolveRolePassword : undefined,
  });
}

/**
 * @param {ReturnType<typeof resolvePostgresqlDeployments>[number]} deployment
 * @param {ReturnType<typeof resolvePostgresqlDeployments>} allDeployments
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof postgresqlGlobalSettings>} global
 * @param {string} superuserPassword
 * @param {string} replicationPassword
 * @param {import("../lib/vault-deps.mjs").createPostgresqlVaultAccess extends () => infer V ? V : never} vault
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
async function deployOne(deployment, allDeployments, flags, global, superuserPassword, replicationPassword, vault, log) {
  const inv = deployTargetInventory(root, target, { systemIdOverride: deployment.systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (skipProvision(flags) || deployment.mode === "configure-only") {
    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} configure-only …\n`);
    const configure = await runConfigure({
      deployment,
      allDeployments,
      global,
      superuserPassword,
      replicationPassword,
      vault,
      log,
    });
    return { ok: true, system_id: deployment.systemId, mode: "configure-only", configure };
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
    `[hdc] ${target} ${verb}: ${deployment.systemId} (${deployment.role}) on ${hostId} vmid ${vmid} …\n`,
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
      const configure = await runConfigure({
        deployment,
        allDeployments,
        global,
        superuserPassword,
        replicationPassword,
        vault,
        log,
      });
      return {
        ok: true,
        system_id: deployment.systemId,
        role: deployment.role,
        skipped_provision: true,
        configure,
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
      role: deployment.role,
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

  const configure = await runConfigure({
    deployment: {
      ...deployment,
      configure: { ssh: { user: sshUser, host: sshHost } },
    },
    allDeployments,
    global,
    superuserPassword,
    replicationPassword,
    vault,
    log,
  });

  return {
    ok: true,
    system_id: deployment.systemId,
    role: deployment.role,
    provision: provisionResult,
    configure,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: PostgreSQL deploy (stderr log; JSON on stdout).\n`);

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
  let allDeployments;
  let toDeploy;
  try {
    normalized = normalizePostgresqlConfig(cfg);
    allDeployments = resolvePostgresqlDeployments(cfg, {});
    toDeploy = resolvePostgresqlDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const global = postgresqlGlobalSettings(normalized);
  const vault = createPostgresqlVaultAccess();
  await vault.unlock({});

  const needReplication = hasStandbyDeployments(allDeployments);
  let replicationPassword = "";
  if (needReplication) {
    const repKey = replicationPasswordVaultKey(
      isObject(normalized.postgresql) ? normalized.postgresql : {},
    );
    errout.write(`[hdc] ${target} ${verb}: loading replication secret ${repKey} …\n`);
    replicationPassword = String(
      await vault.getSecret(repKey, { promptLabel: `vault secret ${repKey}` }),
    ).trim();
    if (!replicationPassword) {
      errout.write(`[hdc] ${target} ${verb}: replication password empty — hdc secrets set ${repKey}\n`);
      process.stdout.write(
        `${JSON.stringify({ ok: false, target, verb, message: "missing replication password" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (toDeploy.length > 1) {
    errout.write(`[hdc] ${target} ${verb}: deploying ${toDeploy.length} instance(s) (primary/standalone before standby) …\n`);
  }

  const log = provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const deployment of toDeploy) {
    const letter = instanceLetterFromSystemId(deployment.systemId);
    const suKey = superuserPasswordVaultKey(
      isObject(normalized.postgresql) ? normalized.postgresql : {},
      letter,
    );
    errout.write(`[hdc] ${target} ${verb}: loading superuser secret ${suKey} for ${deployment.systemId} …\n`);
    const superuserPassword = String(
      await vault.getSecret(suKey, { promptLabel: `vault secret ${suKey}` }),
    ).trim();
    if (!superuserPassword) {
      results.push({
        ok: false,
        system_id: deployment.systemId,
        message: `missing superuser password (${suKey})`,
      });
      continue;
    }

    try {
      results.push(
        await deployOne(
          deployment,
          allDeployments,
          flags,
          global,
          superuserPassword,
          replicationPassword,
          vault,
          log,
        ),
      );
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok !== false);
  const payload = { ok, target, verb, count: results.length, results };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    extraSections: postgresqlReportExtraSections,
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

