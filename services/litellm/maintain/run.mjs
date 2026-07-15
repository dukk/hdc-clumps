#!/usr/bin/env node
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
/**
 * Maintain LiteLLM: re-push config.yaml + .env, refresh Docker images, guest baseline.
 *
 * Usage: hdc run service litellm maintain -- [--instance a | --system-id litellm-a]
 *        hdc run service litellm maintain -- [--skip-upgrade] [--skip-clamav]
 *        hdc run service litellm maintain -- [--align-db-password]
 *        hdc run service litellm maintain -- [--reset-db --yes]
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
import { resolveLitellmDeployments } from "hdc/package/deployments.mjs";
import { maintainLitellmInCt, resolvePveSshForHost } from "hdc/package/litellm-install.mjs";
import { createLitellmVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolveLitellmSecrets } from "hdc/package/vault-secrets.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/litellm/config.example.json";
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
 * @param {ReturnType<typeof resolveLitellmDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {Awaited<ReturnType<typeof resolveLitellmSecrets>>} secrets
 * @param {ReturnType<typeof createPackageVaultAccess>} vaultAccess
 */
async function maintainOne(deployment, flags, secrets, vaultAccess) {
  const { systemId, proxmox: px, litellm, install } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  const resetDb = flagGet(flags, "reset-db", "reset_db") !== undefined;
  const resetDbYes = flagGet(flags, "yes") !== undefined;
  const resetDbConfirmed = resetDb && resetDbYes;
  const alignDbPassword = flagGet(flags, "align-db-password", "align_db_password") !== undefined;

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
  const litellmCfg = isObject(litellm) ? litellm : {};
  const installCfg = isObject(install) ? install : {};
  const result = await maintainLitellmInCt(
    pveSsh.user,
    pveSsh.host,
    vmid,
    litellmCfg,
    installCfg,
    secrets,
    { skipUpgrade, resetDb: resetDbConfirmed, alignDbPassword },
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
    reset_db: resetDbConfirmed,
    db_volume_reset: result.db_volume_reset ?? false,
    db_password_aligned: result.db_password_aligned ?? false,
    api_url: result.api_url ?? null,
    ui_url: result.ui_url ?? null,
    upstream_url: result.upstream_url ?? null,
    message: result.message,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh LiteLLM Docker stack (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const resetDb = flagGet(flags, "reset-db", "reset_db") !== undefined;
  const resetDbYes = flagGet(flags, "yes") !== undefined;
  if (resetDb && !resetDbYes) {
    const msg = "refusing --reset-db without --yes (destroys litellm postgres_data volume)";
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  let deployments;
  try {
    deployments = resolveLitellmDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createLitellmVaultAccess();
  const defaultsLitellm =
    isObject(cfg.defaults) && isObject(cfg.defaults.litellm) ? cfg.defaults.litellm : {};
  const secrets = await resolveLitellmSecrets(vault, defaultsLitellm);

  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainOne(deployment, flags, secrets, vaultAccess));
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
