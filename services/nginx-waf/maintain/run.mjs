#!/usr/bin/env node
/**
 * Maintain nginx WAF: push site configs, optional cert renew/sync.
 *
 * Usage: hdc run service nginx-waf maintain -- [--sync-certs] [--renew-certs] [--site <id>] [--group <id>] [--skip-clamav] [--skip-guest-agent] [--skip-wazuh-log-collection] [--skip-disk-resize] [--dry-run]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { resolveBindTsigForAcme } from "hdc/package/bind-tsig-for-acme.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { createNginxWafVaultAccess } from "hdc/package/vault-deps.mjs";
import {
  findCertPrimaryDeployment,
  findPeerDeployment,
  loadAcmeRootCaContent,
  loadLetsEncryptEmail,
  maintainSiteLists,
  resolveNginxWafDeployments,
  resolveNginxWafGroups,
  sshTargetFromDeployment,
} from "hdc/package/deployments.mjs";
import { groupUsesModsecurity } from "hdc/package/nginx-waf-policies.mjs";
import {
  configureNginxWafSites,
  installNginxWafBase,
  maintainModsecurityCrs,
} from "hdc/package/nginx-waf-configure.mjs";
import { configureExecFromDeployment } from "hdc/package/configure-exec.mjs";
import { runCertSync } from "hdc/package/cert-sync.mjs";
import { obtainMissingCertificates, queryCertExpiry, renewCertificates } from "hdc/package/letsencrypt.mjs";
import { tlsDomainsFromSites } from "hdc/package/nginx-waf-render.mjs";
import { certExistsOnHost } from "hdc/package/letsencrypt.mjs";
import { nginxWafReportExtraSections } from "hdc/package/nginx-waf-report.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import {
  guestBaselineResultFields,
  guestBaselineUsersOk,
  mergeGuestBaselineIntoResult,
} from "hdc/package/guest-baseline-report.mjs";
import { ensureWazuhLogCollection } from "hdc/package/wazuh-log-collection.mjs";
import { resolveNginxWafWazuhLogCollection } from "hdc/package/wazuh-log-collection.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { ensureQemuGuestAgentForDeploymentMaintain } from "../../../infrastructure/proxmox/lib/proxmox-qemu-guest-agent-for-deployment.mjs";
import { syncQemuRootfsOnMaintain } from "hdc/package/qemu-rootfs-resize.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/nginx-waf/config.example.json";
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

const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {ReturnType<typeof resolveNginxWafDeployments>[number]} deployment */
function defaultSshHostForNginxWafMaintain(deployment) {
  const px = deployment.proxmox;
  if (px && typeof px === "object" && !Array.isArray(px)) {
    const q =
      px.qemu && typeof px.qemu === "object" && !Array.isArray(px.qemu) ? px.qemu : {};
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    if (ip) return ip.split("/")[0];
  }
  try {
    return sshTargetFromDeployment(deployment).host;
  } catch {
    return "";
  }
}

async function loadGroupSecrets(global, vault) {
  const email = await loadLetsEncryptEmail(global, vault);
  let tsigSecret = "";
  const needsTsig =
    global.challenge === "dns-01" ||
    (global.dnsZone && global.dnsNameservers?.length);
  if (needsTsig) {
    tsigSecret = await resolveBindTsigForAcme(vault, global.dnsTsigVaultKey, root);
  }
  return { email, tsigSecret };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: nginx WAF site sync and certificates (JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const syncCerts = flagGet(flags, "sync-certs") !== undefined;
  const renewCerts = flagGet(flags, "renew-certs") !== undefined;
  const siteFilter = flagGet(flags, "site");

  let groupContexts;
  let deployments;
  try {
    groupContexts = resolveNginxWafGroups(cfg, flags);
    deployments = resolveNginxWafDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const wazuhLogEntries = resolveNginxWafWazuhLogCollection(cfg);

  const vault = createNginxWafVaultAccess();
  const needVault =
    renewCerts ||
    groupContexts.some(
      (ctx) =>
        ctx.global.challenge === "dns-01" ||
        !ctx.global.email ||
        (ctx.global.dnsZone && ctx.global.dnsNameservers?.length),
    );
  if (needVault) {
    await vault.unlock({});
  }

  const log = provisionLogFromConsole(console);
  const skipGuestAgent = flagGet(flags, "skip-guest-agent") !== undefined;
  /** @type {Record<string, unknown>[]} */
  const results = [];

  const allDeployments = resolveNginxWafDeployments(cfg, {});
  if (!skipGuestAgent) {
    for (const deployment of allDeployments) {
      if (deployment.mode !== "proxmox-qemu") continue;
      errout.write(`[hdc] ${target} ${verb}: qemu-guest-agent on ${deployment.systemId} …\n`);
      const guestAgent = await ensureQemuGuestAgentForDeploymentMaintain({
        proxmoxPackageRoot: proxmoxRoot,
        deployment,
        defaultSshHost: defaultSshHostForNginxWafMaintain(deployment),
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        existing.guest_agent = guestAgent;
        if (!guestAgent.ok) existing.ok = false;
      } else {
        results.push({
          ok: guestAgent.ok !== false,
          system_id: deployment.systemId,
          role: deployment.role,
          guest_agent: guestAgent,
        });
      }
    }
  }

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
          role: deployment.role,
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
          role: deployment.role,
          message: msg,
        });
      }
    }
  }

  if (!syncCerts && !renewCerts) {
    for (const ctx of groupContexts) {
      const global = ctx.global;
      const groupSites = ctx.sites;
      const { allSites, certSites, partialSiteUpdate } = maintainSiteLists(
        global,
        cfg,
        siteFilter,
        ctx.groupId,
      );
      const groupDeployments = ctx.deployments;
      const certPrimary = findCertPrimaryDeployment(groupDeployments, global.certPrimarySystemId);
      const certPeer = findPeerDeployment(groupDeployments, certPrimary);
      const certPrimaryExec = configureExecFromDeployment(certPrimary);
      const { email, tsigSecret } = needVault
        ? await loadGroupSecrets(global, vault)
        : { email: global.email, tsigSecret: "" };

      const missingTlsPrimary = tlsDomainsFromSites(certSites, global).filter(
        (d) => !certExistsOnHost(certPrimaryExec, d),
      );
      if (missingTlsPrimary.length && email) {
        errout.write(
          `[hdc] ${target} ${verb}: group ${ctx.groupId}: obtaining certificate(s) ${missingTlsPrimary.join(", ")} on ${certPrimary.systemId} …\n`,
        );
        if (global.challenge === "dns-01") {
          installNginxWafBase({
            exec: certPrimaryExec,
            log,
            global,
            dns01: true,
            allSites: groupSites,
            rootCaContent: loadAcmeRootCaContent(global.acme),
          });
          obtainMissingCertificates({
            exec: certPrimaryExec,
            log,
            global,
            email,
            sites: certSites,
            tsigSecret,
          });
        } else {
          errout.write(
            `[hdc] ${target} ${verb}: group ${ctx.groupId}: HTTP-01 bootstrap nginx on ${certPrimary.systemId} …\n`,
          );
          configureNginxWafSites({
            exec: certPrimaryExec,
            log,
            global,
            sites: allSites,
            allSites,
            pruneStaleSites: !partialSiteUpdate,
            wafNodeId: certPrimary.systemId,
          });
          obtainMissingCertificates({
            exec: certPrimaryExec,
            log,
            global,
            email,
            sites: certSites,
            tsigSecret,
          });
        }
        if (certPeer) {
          try {
            runCertSync(certPrimaryExec, log);
          } catch (e) {
            const msg = String(/** @type {Error} */ (e).message || e);
            errout.write(
              `[hdc] ${target} ${verb}: group ${ctx.groupId}: cert sync to peer skipped: ${msg.split("\n")[0]}\n`,
            );
          }
        }
      }

      for (const deployment of groupDeployments) {
        errout.write(
          `[hdc] ${target} ${verb}: group ${ctx.groupId}: pushing sites to ${deployment.systemId} …\n`,
        );
        try {
          const exec = configureExecFromDeployment(deployment);
          const siteNeedsWaf = groupUsesModsecurity(global.groupPolicyPlan);
          const modsecurity =
            global.modsecurityEnabled && siteNeedsWaf
              ? maintainModsecurityCrs({ exec, log, global })
              : { configured: false, skipped: true };
          const configure = configureNginxWafSites({
            exec,
            log,
            global,
            sites: allSites,
            allSites,
            pruneStaleSites: !partialSiteUpdate,
            wafNodeId: deployment.systemId,
          });
          const existing = results.find((r) => r.system_id === deployment.systemId);
          const entry = {
            ok: true,
            system_id: deployment.systemId,
            deployment_group: ctx.groupId,
            role: deployment.role,
            modsecurity,
            configure,
          };
          if (existing) Object.assign(existing, entry);
          else results.push(entry);
        } catch (e) {
          const msg = String(/** @type {Error} */ (e).message || e);
          const existing = results.find((r) => r.system_id === deployment.systemId);
          if (existing) {
            existing.ok = false;
            existing.message = msg;
          } else {
            results.push({ ok: false, system_id: deployment.systemId, message: msg });
          }
        }
      }
    }
  }

  if (renewCerts) {
    for (const ctx of groupContexts) {
      const global = ctx.global;
      const { certSites } = maintainSiteLists(global, cfg, siteFilter, ctx.groupId);
      const groupDeployments = ctx.deployments;
      const certPrimary = findCertPrimaryDeployment(groupDeployments, global.certPrimarySystemId);
      const certPeer = findPeerDeployment(groupDeployments, certPrimary);
      const certPrimaryExec = configureExecFromDeployment(certPrimary);
      const { email, tsigSecret } = needVault
        ? await loadGroupSecrets(global, vault)
        : { email: global.email, tsigSecret: "" };
      errout.write(
        `[hdc] ${target} ${verb}: group ${ctx.groupId}: renewing certificates on ${certPrimary.systemId} …\n`,
      );
      try {
        if (!email) throw new Error("ACME account email required");
        if (global.challenge === "dns-01") {
          installNginxWafBase({
            exec: certPrimaryExec,
            log,
            global,
            dns01: true,
            allSites: ctx.sites,
            rootCaContent: loadAcmeRootCaContent(global.acme),
          });
        }
        renewCertificates({ exec: certPrimaryExec, log });
        obtainMissingCertificates({
          exec: certPrimaryExec,
          log,
          global,
          email,
          sites: certSites,
          tsigSecret,
        });
        if (certPeer) runCertSync(certPrimaryExec, log);
        results.push({
          ok: true,
          system_id: certPrimary.systemId,
          deployment_group: ctx.groupId,
          step: "renew-certs",
          synced_to: certPeer?.systemId ?? null,
        });
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        results.push({
          ok: false,
          system_id: certPrimary.systemId,
          deployment_group: ctx.groupId,
          step: "renew-certs",
          message: msg,
        });
      }
    }
  } else if (syncCerts) {
    for (const ctx of groupContexts) {
      const global = ctx.global;
      const groupDeployments = ctx.deployments;
      const certPrimary = findCertPrimaryDeployment(groupDeployments, global.certPrimarySystemId);
      const certPeer = findPeerDeployment(groupDeployments, certPrimary);
      if (!certPeer) continue;
      const certPrimaryExec = configureExecFromDeployment(certPrimary);
      errout.write(
        `[hdc] ${target} ${verb}: group ${ctx.groupId}: syncing certificates to ${certPeer.systemId} …\n`,
      );
      try {
        runCertSync(certPrimaryExec, log);
        results.push({
          ok: true,
          system_id: certPrimary.systemId,
          deployment_group: ctx.groupId,
          step: "sync-certs",
          synced_to: certPeer.systemId,
        });
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        results.push({
          ok: false,
          system_id: certPrimary.systemId,
          deployment_group: ctx.groupId,
          step: "sync-certs",
          message: msg,
        });
      }
    }
  }

  for (const deployment of allDeployments) {
    errout.write(`[hdc] ${target} ${verb}: ClamAV on ${deployment.systemId} …\n`);
    try {
      const cfg = deployment.configure;
      const via =
        cfg && typeof cfg.via === "string" && cfg.via.trim() ? cfg.via.trim().toLowerCase() : "ssh";
      if (via === "qemu-guest") {
        continue;
      }
      const exec = configureExecFromDeployment(deployment);
      const baseline = await ensureGuestLinuxBaseline({
        exec,
        log,
        flags,
        vaultAccess,
        deployment,
        proxmoxPackageRoot: proxmoxRoot,
      });
      const wazuh_log_collection = await ensureWazuhLogCollection({
        exec,
        log,
        flags,
        entries: wazuhLogEntries,
      });
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        mergeGuestBaselineIntoResult(existing, baseline);
        existing.wazuh_log_collection = wazuh_log_collection;
        if (wazuh_log_collection.ok === false && wazuh_log_collection.skipped !== true) {
          existing.ok = false;
        }
      } else {
        results.push({
          ok:
            guestBaselineUsersOk(baseline) &&
            (wazuh_log_collection.ok !== false || wazuh_log_collection.skipped === true),
          system_id: deployment.systemId,
          role: deployment.role,
          ...guestBaselineResultFields(baseline),
          wazuh_log_collection,
        });
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      const existing = results.find((r) => r.system_id === deployment.systemId);
      if (existing) {
        existing.clamav = { ok: false, skipped: false, message: msg };
        existing.ok = false;
      } else {
        results.push({
          ok: false,
          system_id: deployment.systemId,
          clamav: { ok: false, skipped: false, message: msg },
        });
      }
    }
  }

  /** @type {Record<string, unknown>[]} */
  const certStatus = [];
  for (const ctx of groupContexts) {
    const { certSites } = maintainSiteLists(ctx.global, cfg, siteFilter, ctx.groupId);
    const domains = tlsDomainsFromSites(certSites, ctx.global);
    for (const deployment of ctx.deployments) {
      const exec = configureExecFromDeployment(deployment);
      for (const domain of domains) {
        certStatus.push({
          system_id: deployment.systemId,
          deployment_group: ctx.groupId,
          ...queryCertExpiry(exec, domain),
        });
      }
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
    extraSections: nginxWafReportExtraSections,
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
