#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Deploy nginx web nodes: optional Proxmox QEMU provision, base install, sites, per-node certs.
 *
 * Usage: hdc run service nginx deploy -- [--instance a|b] [--skip-provision] [--destroy-existing]
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
import { isProxmoxHostDown } from "../../../infrastructure/proxmox/lib/proxmox-config.mjs";
import { loadProxmoxPackageConfig } from "../../../infrastructure/proxmox/lib/proxmox-package-config.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { fetchClusterVmResources } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { pveJsonRequest } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import { ensureQemuGuestAgentOnDeploy } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-install.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForCloneTaskAndEnableAgent } from "../../../infrastructure/proxmox/lib/proxmox-qemu-post-clone.mjs";
import { createNginxVaultAccess } from "hdc/package/vault-deps.mjs";
import {
  nginxGlobalSettings,
  normalizeNginxConfig,
  resolveNginxDeployments,
  sshTargetFromDeployment,
} from "hdc/package/deployments.mjs";
import {
  configureNginxSites,
  createConfigureExec,
  ensureAcmeBootstrapVhost,
  installNginxBase,
} from "hdc/package/nginx-configure.mjs";
import { obtainMissingCertificates } from "hdc/package/letsencrypt.mjs";
import { tlsDomainsFromSites } from "hdc/package/nginx-render.mjs";
import {
  applyQemuCloudInit,
  cloneQemuGuest,
  locateGuest,
  startQemuGuest,
  stopAndDestroyQemu,
  waitForQemuGuestSshAfterBoot,
} from "hdc/package/proxmox-qemu-redeploy.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/nginx/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const target = basename(dirname(here));
const verb = basename(here);
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
 * @param {Awaited<ReturnType<typeof authorizeProxmoxForHost>>} auth
 * @param {string} node
 * @param {number} vmid
 * @param {(line: string) => void} logLine
 */
async function destroyOrphanQemuConfig(auth, node, vmid, logLine) {
  try {
    await pveJsonRequest(
      "GET",
      auth.host.apiBase,
      `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`,
      auth.authorization,
      auth.rejectUnauthorized,
      undefined,
    );
    errout.write(
      `[hdc] ${target} ${verb}: orphan config for vmid ${vmid} on ${node} — destroying …\n`,
    );
    await stopAndDestroyQemu({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node,
      vmid,
      log: logLine,
    });
  } catch {
    /* no config on this node */
  }
}

/**
 * @param {Awaited<ReturnType<typeof authorizeProxmoxForHost>>} auth
 * @param {number} vmid
 * @param {number} [timeoutMs]
 */
async function waitUntilGuestAbsent(auth, vmid, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await locateGuest(
      auth.host.apiBase,
      auth.authorization,
      auth.rejectUnauthorized,
      vmid,
    );
    if (!found) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`vmid ${vmid} still present in cluster after destroy (waited ${timeoutMs}ms)`);
}

/**
 * @param {Awaited<ReturnType<typeof authorizeProxmoxForHost>>} auth
 * @param {number} vmid
 * @param {string} hostId
 * @param {(line: string) => void} logLine
 */
async function destroyQemuVmidInCluster(auth, vmid, hostId, logLine) {
  const nodes = new Set();
  if (auth.host.pveNode) nodes.add(auth.host.pveNode);
  if (hostId === "pve-c") nodes.add("pve-b");
  try {
    const resources = await fetchClusterVmResources(
      auth.host.apiBase,
      auth.authorization,
      auth.rejectUnauthorized,
    );
    for (const r of resources) {
      if (typeof r.vmid === "number" && r.vmid === vmid && typeof r.node === "string" && r.node.trim()) {
        nodes.add(r.node.trim());
      }
    }
  } catch (e) {
    errout.write(
      `[hdc] ${target} ${verb}: cluster resource scan for vmid ${vmid}: ${String(/** @type {Error} */ (e).message || e)}\n`,
    );
  }
  try {
    const { data } = loadProxmoxPackageConfig(proxmoxRoot);
    const clusters = Array.isArray(data.clusters) ? data.clusters : [];
    for (const cl of clusters) {
      if (!cl || typeof cl !== "object" || Array.isArray(cl)) continue;
      const hosts = Array.isArray(/** @type {Record<string, unknown>} */ (cl).hosts)
        ? /** @type {Record<string, unknown>[]} */ (/** @type {Record<string, unknown>} */ (cl).hosts)
        : [];
      for (const h of hosts) {
        if (isProxmoxHostDown(h)) continue;
        const pveNode =
          typeof h.pve_node === "string" && h.pve_node.trim()
            ? h.pve_node.trim()
            : typeof h.id === "string"
              ? h.id.trim()
              : "";
        if (pveNode) nodes.add(pveNode);
      }
    }
  } catch {
    /* optional */
  }
  for (const node of nodes) {
    try {
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node,
        vmid,
        log: logLine,
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: destroy vmid ${vmid} on ${node}: ${msg} (continuing)\n`);
    }
    await destroyOrphanQemuConfig(auth, node, vmid, logLine);
  }
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
function skipInstall(flags) {
  return flagGet(flags, "skip-install") !== undefined;
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
 * Install packages, obtain LE certs, then push site vhosts (443 needs certs on disk).
 * @param {ReturnType<typeof resolveNginxDeployments>[number]} deployment
 * @param {ReturnType<typeof nginxGlobalSettings>} global
 * @param {Record<string, unknown>[]} sites
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {boolean} skipBaseInstall
 * @param {string} email
 * @param {string} tsigSecret
 */
function runDeployConfigure(deployment, global, sites, log, skipBaseInstall, email, tsigSecret) {
  const { user, host } = sshTargetFromDeployment(deployment);
  const exec = createConfigureExec("ssh", { user, host });
  if (!skipBaseInstall) {
    installNginxBase({ exec, log, global, dns01: global.challenge === "dns-01" });
  }
  if (global.challenge === "http-01" && tlsDomainsFromSites(sites).length > 0) {
    ensureAcmeBootstrapVhost({ exec, log, webroot: global.webroot });
  }
  const certificates = obtainMissingCertificates({
    exec,
    log,
    global,
    email,
    sites,
    tsigSecret,
  });
  const sitesResult = configureNginxSites({ exec, log, global, sites });
  return { ...sitesResult, certificates };
}

/**
 * @param {ReturnType<typeof resolveNginxDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof nginxGlobalSettings>} global
 * @param {Record<string, unknown>[]} sites
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {string} email
 * @param {string} tsigSecret
 */
async function deployOne(deployment, flags, global, sites, log, email, tsigSecret) {
  const inv = deployTargetInventory(root, target, { systemIdOverride: deployment.systemId });
  logDeployInventoryStatus(target, verb, inv);

  const skipBase = skipInstall(flags) || !deployment.installEnabled;

  if (skipProvision(flags) || deployment.mode === "configure-only") {
    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} configure-only …\n`);
    try {
      const configure = runDeployConfigure(deployment, global, sites, log, skipBase, email, tsigSecret);
      return { ok: true, system_id: deployment.systemId, mode: "configure-only", configure };
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId}: ${msg}\n`);
      return { ok: false, system_id: deployment.systemId, mode: "configure-only", message: msg };
    }
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

  errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} on ${hostId} vmid ${vmid} …\n`);
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
    } else if (action === "destroy" || policy === "destroy") {
      const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
      await destroyQemuVmidInCluster(auth, vmid, hostId, logLine);
      await waitUntilGuestAbsent(auth, vmid);
    } else {
      errout.write(
        `[hdc] ${target} ${verb}: guest exists — configure only (use --destroy-existing to rebuild).\n`,
      );
      try {
        const configure = runDeployConfigure(deployment, global, sites, log, skipBase, email, tsigSecret);
        return {
          ok: true,
          system_id: deployment.systemId,
          skipped_provision: true,
          configure,
        };
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        return { ok: false, system_id: deployment.systemId, skipped_provision: true, message: msg };
      }
    }
  } else if (policy === "destroy") {
    const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
    await destroyQemuVmidInCluster(auth, vmid, hostId, logLine);
    await waitUntilGuestAbsent(auth, vmid);
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

  try {
    const configure = runDeployConfigure(
      {
        ...deployment,
        configure: { ssh: { user: sshUser, host: sshHost } },
      },
      global,
      sites,
      log,
      skipBase,
      email,
      tsigSecret,
    );
    return {
      ok: true,
      system_id: deployment.systemId,
      provision: provisionResult,
      configure,
    };
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    return { ok: false, system_id: deployment.systemId, provision: provisionResult, message: msg };
  }
}

/**
 * @param {ReturnType<typeof nginxGlobalSettings>} global
 * @param {Awaited<ReturnType<typeof createNginxVaultAccess>>} vault
 */
async function loadSecrets(global, vault) {
  let leEmail = global.email;
  if (!leEmail) {
    leEmail = String(
      await vault.getSecret(global.emailVaultKey, {
        promptLabel: `vault secret ${global.emailVaultKey}`,
      }),
    ).trim();
  }
  let tsigSecret = "";
  if (global.challenge === "dns-01") {
    tsigSecret = String(
      await vault.getSecret(global.dnsTsigVaultKey, {
        promptLabel: `vault secret ${global.dnsTsigVaultKey}`,
      }),
    ).trim();
  }
  return { email: leEmail, tsigSecret };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: nginx web reverse proxy (stderr log; JSON on stdout).\n`);

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
    normalized = normalizeNginxConfig(cfg);
    deployments = resolveNginxDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const global = nginxGlobalSettings(normalized);
  const sites = /** @type {Record<string, unknown>[]} */ (global.sites);
  const tlsDomains = tlsDomainsFromSites(sites);
  const needVault = tlsDomains.length > 0 || global.challenge === "dns-01";

  const vault = createNginxVaultAccess();
  let email = global.email;
  let tsigSecret = "";
  if (needVault) {
    errout.write(`[hdc] ${target} ${verb}: unlocking vault …\n`);
    await vault.unlock({});
    const secrets = await loadSecrets(global, vault);
    email = secrets.email;
    tsigSecret = secrets.tsigSecret;
    if (tlsDomains.length > 0 && !email) {
      errout.write(
        `[hdc] ${target} ${verb}: Let's Encrypt email missing — set letsencrypt.email or hdc secrets set ${global.emailVaultKey}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({ ok: false, target, verb, message: "missing Let's Encrypt email" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const log = provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const deployment of deployments) {
    try {
      results.push(await deployOne(deployment, flags, global, sites, log, email, tsigSecret));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.every((r) => r.ok === true);
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

