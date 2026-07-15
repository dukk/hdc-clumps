#!/usr/bin/env node
/**
 * Maintain nginx web nodes: push site configs, optional cert renew.
 *
 * Usage: hdc run service nginx maintain -- [--renew-certs] [--site <id>] [--skip-clamav] [--skip-disk-resize] [--dry-run]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { createNginxVaultAccess } from "hdc/package/vault-deps.mjs";
import {
  nginxGlobalSettings,
  normalizeNginxConfig,
  resolveNginxDeployments,
  resolveSites,
  sshTargetFromDeployment,
} from "hdc/package/deployments.mjs";
import { configureNginxSites, createConfigureExec } from "hdc/package/nginx-configure.mjs";
import { obtainMissingCertificates, queryCertExpiry, renewCertificates } from "hdc/package/letsencrypt.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { mergeGuestBaselineIntoResult, guestBaselineUsersOk, guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { syncQemuRootfsOnMaintain } from "hdc/package/qemu-rootfs-resize.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { tlsDomainsFromSites } from "hdc/package/nginx-render.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
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
function readCfg() {
  return ensurePackageConfig().data;
}
function tryCfg() {
  return tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
}

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

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
  errout.write(`[hdc] ${target} ${verb}: nginx site sync and certificates (JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const renewCerts = flagGet(flags, "renew-certs") !== undefined;
  const siteFilter = flagGet(flags, "site");

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
  const partialSiteUpdate = Boolean(siteFilter);
  const sites = /** @type {Record<string, unknown>[]} */ (
    siteFilter ? resolveSites(cfg, siteFilter) : global.sites
  );
  if (partialSiteUpdate) {
    errout.write(
      `[hdc] ${target} ${verb}: updating site ${JSON.stringify(siteFilter)} only (other vhosts unchanged)\n`,
    );
  }

  const vault = createNginxVaultAccess();
  const needVault = renewCerts || global.challenge === "dns-01" || !global.email;
  if (needVault) {
    await vault.unlock({});
  }
  const { email, tsigSecret } = needVault
    ? await loadSecrets(global, vault)
    : { email: global.email, tsigSecret: "" };

  const log = provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const results = [];

  const allDeployments = resolveNginxDeployments(cfg, {});
  for (const deployment of allDeployments) {
    if (deployment.mode !== "proxmox-qemu") continue;
    errout.write(`[hdc] ${target} ${verb}: disk resize check on ${deployment.systemId} …\n`);
    try {
      const diskResize = await syncQemuRootfsOnMaintain({
        proxmoxPackageRoot: proxmoxRoot,
        deployment,
        flags,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        existing.disk_resize = diskResize;
        if (diskResize.ok === false) existing.ok = false;
      } else {
        results.push({
          ok: diskResize.ok !== false,
          system_id: deployment.systemId,
          disk_resize: diskResize,
        });
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} disk resize failed: ${msg}\n`);
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        existing.ok = false;
        existing.message = msg;
      } else {
        results.push({
          ok: false,
          system_id: deployment.systemId,
          message: msg,
        });
      }
    }
  }

  if (!renewCerts) {
    for (const deployment of deployments) {
      errout.write(`[hdc] ${target} ${verb}: pushing sites to ${deployment.systemId} …\n`);
      try {
        const { user, host } = sshTargetFromDeployment(deployment);
        const exec = createConfigureExec("ssh", { user, host });
        const configure = configureNginxSites({
          exec,
          log,
          global,
          sites,
          pruneStaleSites: !partialSiteUpdate,
        });
        results.push({
          ok: true,
          system_id: deployment.systemId,
          configure,
        });
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        results.push({ ok: false, system_id: deployment.systemId, message: msg });
      }
    }
  }

  if (renewCerts) {
    for (const deployment of deployments) {
      errout.write(`[hdc] ${target} ${verb}: renewing certificates on ${deployment.systemId} …\n`);
      try {
        if (!email) throw new Error("Let's Encrypt email required");
        const { user, host } = sshTargetFromDeployment(deployment);
        const exec = createConfigureExec("ssh", { user, host });
        renewCertificates({ exec, log });
        const certResult = obtainMissingCertificates({
          exec,
          log,
          global,
          email,
          sites,
          tsigSecret,
        });
        configureNginxSites({ exec, log, global, sites });
        results.push({
          ok: true,
          system_id: deployment.systemId,
          step: "renew-certs",
          certificates: certResult,
        });
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        results.push({ ok: false, system_id: deployment.systemId, step: "renew-certs", message: msg });
      }
    }
  }

  const domains = tlsDomainsFromSites(sites);
  for (const deployment of allDeployments) {
    errout.write(`[hdc] ${target} ${verb}: ClamAV on ${deployment.systemId} …\n`);
    try {
      const { user, host } = sshTargetFromDeployment(deployment);
      const exec = createConfigureExec("ssh", { user, host });
      const baseline = await ensureGuestLinuxBaseline({
        exec,
        log,
        flags,
        vaultAccess,
        deployment,
        proxmoxPackageRoot: proxmoxRoot,
      });
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        mergeGuestBaselineIntoResult(existing, baseline);
      } else {
        results.push({
          ok: guestBaselineUsersOk(baseline),
          system_id: deployment.systemId,
          ...guestBaselineResultFields(baseline),
        });
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        existing.clamav = { ok: false, skipped: false, message: msg };
        existing.ok = false;
      } else {
        results.push({ ok: false, system_id: deployment.systemId, clamav: { ok: false, skipped: false, message: msg } });
      }
    }
  }

  /** @type {Record<string, unknown>[]} */
  const certStatus = [];
  for (const deployment of allDeployments) {
    const exec = createConfigureExec("ssh", sshTargetFromDeployment(deployment));
    for (const domain of domains) {
      certStatus.push({
        system_id: deployment.systemId,
        ...queryCertExpiry(exec, domain),
      });
    }
  }

  const ok = results.length === 0 || results.every((r) => r.ok !== false);
  const payload = {
    ok,
    target,
    verb,
    results,
    certificates: certStatus,
    generated_at: new Date().toISOString(),
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
