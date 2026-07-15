#!/usr/bin/env node
/**
 * Deploy Postfix as an outbound SMTP relay on Proxmox (LXC) or an existing SSH host.
 *
 * Provisions an LXC when deploy.mode is proxmox-lxc (unless deploy.skip_provision).
 * Configures relayhost + SASL using vault keys from config (see config.example.json).
 *
 * Usage: hdc run service postfix-relay deploy -- [--skip-existing | --redeploy-existing] [--password <secret>]
 */
import { lxcHostnameFromSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout, env } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { createPostfixRelayVaultAccess } from "hdc/package/vault-deps.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForLxcCreateTaskAndApplyResources } from "../../../infrastructure/proxmox/lib/proxmox-lxc-post-create.mjs";
import { ensureLxcStarted } from "../../../infrastructure/proxmox/lib/proxmox-lxc-start.mjs";
import { resolveProvisionVmid } from "../../../infrastructure/proxmox/lib/proxmox-vmid-conflict.mjs";
import { findClusterGuest } from "../../gatus/lib/guest-exists.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { readCtPrimaryIp } from "../../pi-hole/lib/pi-hole-install.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";
import { configurePostfixRelay } from "hdc/package/postfix-relay-configure.mjs";
import { resolveConfigureTarget } from "hdc/package/configure-target.mjs";
import { promptExistingGuestAction } from "hdc/package/prompt-existing.mjs";
import { waitForPostfixRelayProvisionTask } from "hdc/package/proxmox-task-wait.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/postfix-relay/config.example.json";
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {Record<string, unknown>} smtp
 * @param {ReturnType<typeof createPostfixRelayVaultAccess>} vault
 */
async function resolveSmtpCredentials(smtp, vault) {
  const userKey =
    (typeof smtp.auth_user_vault_key === "string" && smtp.auth_user_vault_key.trim()) ||
    "HDC_POSTFIX_RELAY_SMTP_USER";
  const passKey =
    (typeof smtp.auth_pass_vault_key === "string" && smtp.auth_pass_vault_key.trim()) ||
    "HDC_POSTFIX_RELAY_SMTP_PASSWORD";
  const userEnv =
    typeof smtp.auth_user_env === "string" && smtp.auth_user_env.trim() ? smtp.auth_user_env.trim() : userKey;

  let user = String(env[userEnv] ?? "").trim();
  if (!user) {
    const fromVault = await vault.getSecret(userKey, { promptLabel: `vault secret ${userKey}` });
    user = String(fromVault ?? "").trim();
  }
  let pass = String(env[passKey] ?? "").trim();
  if (!pass) {
    pass = String(await vault.getSecret(passKey, { promptLabel: `vault secret ${passKey}` })).trim();
  }
  if (!user || !pass) {
    throw new Error(
      `SMTP credentials missing — set ${userEnv} and ${passKey} in .env, or vault ${userKey} / ${passKey} (hdc secrets set)`,
    );
  }
  errout.write(
    `[hdc] ${target} ${verb}: SMTP user from ${env[userEnv] ? `env ${userEnv}` : `vault ${userKey}`}; password from ${env[passKey] ? `env ${passKey}` : `vault ${passKey}`}\n`,
  );
  return { user, pass };
}

/**
 * @param {Record<string, string>} flags
 */
function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  return "prompt";
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} systemId
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {ReturnType<typeof createPostfixRelayVaultAccess>} vault
 */
async function deployFromConfig(cfg, systemId, flags, log, vault) {
  const deploy = isObject(cfg.deploy) ? cfg.deploy : {};
  const mode = typeof deploy.mode === "string" ? deploy.mode.trim() : "";
  const skipProvisionConfig = deploy.skip_provision === true;

  const smtp = isObject(cfg.smtp) ? cfg.smtp : {};
  const postfix = isObject(cfg.postfix) ? cfg.postfix : {};
  const { user: smtpUser, pass: smtpPass } = await resolveSmtpCredentials(smtp, vault);

  /** @type {import("../../../lib/host-provisioner.mjs").ProvisionResult | null} */
  let provisionResult = null;
  let skipProvision = skipProvisionConfig;

  if (mode === "configure-only") {
    errout.write(`[hdc] ${target} ${verb}: configure-only (no Proxmox provision).\n`);
  } else if (mode !== "proxmox-lxc") {
    return { ok: false, system_id: systemId, message: "set deploy.mode to proxmox-lxc or configure-only" };
  } else if (skipProvision) {
    errout.write(`[hdc] ${target} ${verb}: skip_provision — configuring existing guest only.\n`);
  } else {
    const px = isObject(cfg.proxmox) ? cfg.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) {
      return { ok: false, system_id: systemId, message: "missing proxmox.host_id" };
    }
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      return { ok: false, system_id: systemId, message: "invalid proxmox.lxc.vmid" };
    }
    const memoryMb = typeof lxc.memory_mb === "number" ? lxc.memory_mb : Number(lxc.memory_mb);
    const cores = typeof lxc.cores === "number" ? lxc.cores : Number(lxc.cores);
    const diskGb = typeof lxc.rootfs_gb === "number" ? lxc.rootfs_gb : Number(lxc.rootfs_gb);
    if (![memoryMb, cores, diskGb].every((n) => Number.isFinite(n) && n > 0)) {
      return { ok: false, system_id: systemId, message: "invalid lxc sizing fields" };
    }

    errout.write(
      `[hdc] ${target} ${verb}: ${systemId} on ${JSON.stringify(hostId)} (vmid ${vmid}) …\n`,
    );
    const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId, vault });
    const located = await findClusterGuest(
      auth.host.apiBase,
      auth.authorization,
      auth.rejectUnauthorized,
      vmid,
    );

    if (located) {
      const policy = existingGuestPolicy(flags);
      let action = policy;
      if (policy === "prompt") {
        action = await promptExistingGuestAction(target, systemId, vmid, located.node, located.name);
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
        `[hdc] ${target} ${verb}: vmid ${vmid} exists — redeploy (provision skipped, configure only).\n`,
      );
      skipProvision = true;
      provisionResult = {
        ok: true,
        message: `LXC ${vmid} already present on ${located.node}`,
        details: { vmid, node: located.node, type: "lxc", skipped_provision: true },
      };
    }

    if (!skipProvision) {
      const hostname =
        (typeof lxc.hostname === "string" && lxc.hostname.trim()) ||
        lxcHostnameFromSystemId(systemId) ||
        "postfix-relay";
      const ctPasswordCache = { value: null };
      const rootPassword = await resolveLxcRootPassword(systemId, vmid, lxc, flags, {
        cached: ctPasswordCache.value,
        setCached: (v) => {
          ctPasswordCache.value = v;
        },
      });
      const prov = createProxmoxHostProvisioner({
        apiBase: auth.host.apiBase,
        pveNode: auth.host.pveNode,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        clumpId: target,
  });
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
          provision: provisionResult,
        };
      }
      await waitForPostfixRelayProvisionTask(
        provisionResult,
        auth,
        `${target} ${verb}: ${systemId}`,
        vmid,
      );
    }

    const guestVmid = resolveProvisionVmid(provisionResult, vmid);
    const lxcNode =
      (typeof provisionResult?.details?.node === "string" && provisionResult.details.node.trim()) ||
      located?.node ||
      auth.host.pveNode;

    await waitForLxcCreateTaskAndApplyResources(
      provisionResult,
      auth,
      vmid,
      (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
      guestResourceOptsFromBlock(lxc, flags),
    );

    await ensureLxcStarted({
      apiBase: auth.host.apiBase,
      node: lxcNode,
      vmid: guestVmid,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    });
  }

  if (mode === "proxmox-lxc") {
    const px = isObject(cfg.proxmox) ? cfg.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    if (hostId && Number.isFinite(vmid) && vmid > 0) {
      const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId, vault });
      const located = await findClusterGuest(
        auth.host.apiBase,
        auth.authorization,
        auth.rejectUnauthorized,
        vmid,
      );
      const lxcNode = located?.node || auth.host.pveNode;
      await ensureLxcStarted({
        apiBase: auth.host.apiBase,
        node: lxcNode,
        vmid,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
      });
    }
  }

  const { via, exec } = resolveConfigureTarget(proxmoxRoot, cfg);
  errout.write(`[hdc] ${target} ${verb}: configuring Postfix via ${via} (${exec.label}) …\n`);

  const configResult = configurePostfixRelay({
    exec,
    log,
    postfix,
    smtp,
    smtpUser,
    smtpPass,
  });

  let ip = null;
  if (mode === "proxmox-lxc" && via === "pct") {
    const px = isObject(cfg.proxmox) ? cfg.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    if (hostId && Number.isFinite(vmid) && vmid > 0) {
      const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
      ip = readCtPrimaryIp(pveSsh.user, pveSsh.host, vmid);
    }
  }

  return {
    ok: true,
    system_id: systemId,
    mode,
    configure_via: via,
    ip,
    smtp_relay: ip ? `smtp://${ip}` : null,
    provision: provisionResult,
    configure: configResult,
  };
}

async function main() {
  errout.write(
    `[hdc] ${target} ${verb}: Postfix SMTP relay (Proxmox LXC + configure; stderr log; JSON on stdout).\n`,
  );

  const inv = deployTargetInventory(root, target);
  logDeployInventoryStatus(target, verb, inv);

  if (!inv.ready) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  ensurePackageConfig();
  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const deploy = isObject(cfg.deploy) ? cfg.deploy : {};
  const systemId =
    (typeof deploy.system_id === "string" && deploy.system_id.trim()) || inv.systemId;

  const vault = createPostfixRelayVaultAccess();
  errout.write(`[hdc] ${target} ${verb}: loading SMTP credentials from vault …\n`);
  await vault.unlock({});

  const log = provisionLogFromConsole(console);
  let result;
  try {
    result = await deployFromConfig(cfg, systemId, flags, log, vault);
  } catch (e) {
    const msg = /** @type {Error} */ (e).message || String(e);
    errout.write(`[hdc] ${target} ${verb}: failed: ${msg}\n`);
    const payload = { ok: false, target, verb, system_id: systemId, message: msg };
    runOperationReportTail({
      clumpRoot,
      repoRoot: root,
      verb,
      argv: process.argv.slice(2),
      payload,
      ok: false,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const ok = result.ok === true;
  const payload = { ok, target, verb, ...result };
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
