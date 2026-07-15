#!/usr/bin/env node
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Re-apply Postfix relay configuration from clumps/services/postfix-relay/config.json.
 *
 * Usage: hdc run service postfix-relay maintain --
 *        hdc run service postfix-relay maintain -- --apply-network [--dry-run]
 *        [--skip-resources] [--no-reboot] [--reboot]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout, env } from "node:process";

import { buildNet0, gatewayFromProxmox, resolveLxcIpConfig } from "hdc/package/lxc-network.mjs";
import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { applyLxcNet0 } from "../../../infrastructure/proxmox/lib/proxmox-lxc-network.mjs";
import { syncProxmoxGuestResourcesOnMaintain } from "hdc/package/proxmox-guest-resources-maintain.mjs";
import { createPostfixRelayVaultAccess } from "hdc/package/vault-deps.mjs";
import { configurePostfixRelay } from "hdc/package/postfix-relay-configure.mjs";
import { resolveConfigureTarget } from "hdc/package/configure-target.mjs";
import { ensureWazuhLogCollection } from "hdc/package/wazuh-log-collection.mjs";
import { resolvePostfixRelayWazuhLogCollection } from "hdc/package/wazuh-log-collection.mjs";

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

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
async function applyNetworkFromConfig(cfg, flags) {
  const px = isObject(cfg.proxmox) ? cfg.proxmox : {};
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!hostId || !Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, message: "missing proxmox.host_id or proxmox.lxc.vmid" };
  }

  const dryRun = flags["dry-run"] !== undefined;
  const gateway = gatewayFromProxmox(px);
  const ipConfig = resolveLxcIpConfig(lxc, { gateway });
  if (!ipConfig) {
    errout.write(
      `[hdc] ${target} ${verb}: no static ip_config (set proxmox.lxc.ip_config) — skipping network apply.\n`,
    );
    return { ok: true, skipped: true, message: "no static ip_config in config" };
  }

  const bridge = typeof lxc.bridge === "string" && lxc.bridge.trim() ? lxc.bridge.trim() : "vmbr0";
  const net0 = buildNet0(bridge, ipConfig);
  errout.write(`[hdc] ${target} ${verb}: apply network ${ipConfig} (net0=${net0}) …\n`);

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const node = auth.host.pveNode;
  const applied = await applyLxcNet0({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node,
    vmid,
    net0,
    dryRun,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  return {
    ok: applied.ok,
    host_id: hostId,
    vmid,
    ip_config: ipConfig,
    applied: applied.net0,
    previous_net0: applied.previous_net0,
    ip: applied.ip,
    dry_run: applied.dry_run ?? false,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: re-apply Postfix relay config.\n`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const applyNetwork = flags["apply-network"] !== undefined;

  let cfg;
  try {
    const loaded = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: CLUMP_CONFIG_EXAMPLE,
      log: (line) => errout.write(line),
    });
    cfg = loaded.data;
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message || e}\n`);
    process.exitCode = 1;
    return;
  }

  const deploy = isObject(cfg.deploy) ? cfg.deploy : {};
  const deployMode = typeof deploy.mode === "string" ? deploy.mode.trim() : "";
  /** @type {Record<string, unknown> | null} */
  let guestResources = null;
  if (deployMode === "proxmox-lxc") {
    const deployment = {
      mode: deployMode,
      proxmox: cfg.proxmox,
      system_id: typeof deploy.system_id === "string" ? deploy.system_id : "postfix-relay-a",
    };
    guestResources = await syncProxmoxGuestResourcesOnMaintain({
      deployment,
      proxmoxPackageRoot: proxmoxRoot,
      flags,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
    if (!guestResources.ok) {
      errout.write(
        `[hdc] ${target} ${verb}: guest resource sync failed: ${guestResources.message ?? "unknown"}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  /** @type {Record<string, unknown> | null} */
  let network = null;
  if (applyNetwork) {
    try {
      network = await applyNetworkFromConfig(cfg, flags);
      if (!network.ok) {
        const payload = { ok: false, target, verb, network };
        runOperationReportTail({
          clumpRoot,
          repoRoot: root,
          verb,
          argv: process.argv.slice(2),
          payload,
          ok: false,
          log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
        });
        process.exitCode = 1;
        return;
      }
      if (network.ip) {
        errout.write(`[hdc] ${target} ${verb}: network applied — CT IP ${network.ip}\n`);
      }
    } catch (e) {
      const msg = /** @type {Error} */ (e).message || String(e);
      errout.write(`[hdc] ${target} ${verb}: network apply failed: ${msg}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const vault = createPostfixRelayVaultAccess();
  await vault.unlock({});

  const smtp = isObject(cfg.smtp) ? cfg.smtp : {};
  const postfix = isObject(cfg.postfix) ? cfg.postfix : {};
  const userKey =
    (typeof smtp.auth_user_vault_key === "string" && smtp.auth_user_vault_key.trim()) ||
    "HDC_POSTFIX_RELAY_SMTP_USER";
  const passKey =
    (typeof smtp.auth_pass_vault_key === "string" && smtp.auth_pass_vault_key.trim()) ||
    "HDC_POSTFIX_RELAY_SMTP_PASSWORD";
  const userEnv =
    typeof smtp.auth_user_env === "string" && smtp.auth_user_env.trim() ? smtp.auth_user_env.trim() : userKey;

  let smtpUser = String(env[userEnv] ?? "").trim();
  if (!smtpUser) {
    smtpUser = String(await vault.getSecret(userKey, { promptLabel: userKey })).trim();
  }
  let smtpPass = String(env[passKey] ?? "").trim();
  if (!smtpPass) {
    smtpPass = String(await vault.getSecret(passKey, { promptLabel: passKey })).trim();
  }

  const { via, exec } = resolveConfigureTarget(proxmoxRoot, cfg);
  const log = provisionLogFromConsole(console);
  const packageVault = createPackageVaultAccess();
  await packageVault.unlock({});
  /** @type {Record<string, unknown> | null} */
  let baseline = null;
  if (deployMode === "proxmox-lxc") {
    errout.write(`[hdc] ${target} ${verb}: guest baseline …\n`);
    baseline = await ensureGuestLinuxBaseline({
      exec,
      log,
      flags,
      vaultAccess: packageVault,
      deployment: {
        mode: deployMode,
        proxmox: cfg.proxmox,
        system_id: typeof deploy.system_id === "string" ? deploy.system_id : "postfix-relay-a",
      },
      proxmoxPackageRoot: proxmoxRoot,
    });
  }
  /** @type {Awaited<ReturnType<typeof ensureWazuhLogCollection>> | null} */
  let wazuh_log_collection = null;
  if (deployMode === "proxmox-lxc" && baseline) {
    wazuh_log_collection = await ensureWazuhLogCollection({
      exec,
      log,
      flags,
      entries: resolvePostfixRelayWazuhLogCollection(cfg),
    });
  }
  let payload;
  try {
    const configure = configurePostfixRelay({ exec, log, postfix, smtp, smtpUser, smtpPass });
    errout.write(`[hdc] ${target} ${verb}: ok (${via}).\n`);
    const baselineOk = !baseline || baseline.admin_user?.ok !== false;
    const logsOk = !wazuh_log_collection || wazuh_log_collection.ok !== false || wazuh_log_collection.skipped === true;
    payload = {
      ok: baselineOk && logsOk,
      target,
      verb,
      configure_via: via,
      network,
      guest_resources: guestResources,
      configure,
      ...(baseline
        ? {
            ...guestBaselineResultFields(baseline),
            ...(wazuh_log_collection ? { wazuh_log_collection } : {}),
          }
        : {}),
    };
  } catch (e) {
    const msg = /** @type {Error} */ (e).message || String(e);
    errout.write(`[hdc] ${target} ${verb}: failed: ${msg}\n`);
    payload = {
      ok: false,
      target,
      verb,
      network,
      guest_resources: guestResources,
      ...(baseline
        ? {
            ...guestBaselineResultFields(baseline),
          }
        : {}),
      message: msg,
    };
    process.exitCode = 1;
  }

  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok: payload.ok === true,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.exitCode = 1;
});

