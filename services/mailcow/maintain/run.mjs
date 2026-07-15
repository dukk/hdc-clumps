#!/usr/bin/env node
/**
 * Maintain Mailcow: refresh stack, reconcile domains/DKIM/relay via API, guest baseline.
 *
 * Usage: hdc run service mailcow maintain -- [--instance a | --system-id vm-mailcow-a]
 *        hdc run service mailcow maintain -- [--skip-upgrade] [--skip-domains] [--skip-cloudflare-dkim] [--skip-mailboxes] [--skip-aliases] [--prune] [--rotate-mailbox-passwords] [--skip-clamav]
 */
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
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
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import { resolveMailcowDeployments } from "hdc/package/deployments.mjs";
import { reconcileMailcowDomainsForConfig } from "hdc/package/mailcow-domains.mjs";
import { reconcileMailcowMailboxesForConfig } from "hdc/package/mailcow-mailboxes.mjs";
import { resolveMailcowApiKey } from "hdc/package/vault-secrets.mjs";
import {
  maintainMailcowStackInCt,
  maintainMailcowStackOnHost,
  resolvePveSshForHost,
} from "hdc/package/mailcow-install.mjs";
import { createMailcowVaultAccess } from "hdc/package/vault-deps.mjs";

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
 * @param {ReturnType<typeof resolveMailcowDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {ReturnType<typeof createMailcowVaultAccess>} vault
 */
async function maintainOne(deployment, flags, vault) {
  const { systemId, mode, proxmox: px, mailcow, install, configure } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  const skipDomains = flagGet(flags, "skip-domains", "skip_domains") !== undefined;
  const skipCloudflareDkim =
    flagGet(flags, "skip-cloudflare-dkim", "skip_cloudflare_dkim") !== undefined;
  const skipMailboxes = flagGet(flags, "skip-mailboxes", "skip_mailboxes") !== undefined;
  const skipAliases = flagGet(flags, "skip-aliases", "skip_aliases") !== undefined;
  const prune = flagGet(flags, "prune") !== undefined;
  const rotateMailboxPasswords =
    flagGet(flags, "rotate-mailbox-passwords", "rotate_mailbox_passwords") !== undefined;
  const skipBaseline = flagGet(flags, "skip-baseline", "skip_baseline") !== undefined;

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const mailcowCfg = isObject(mailcow) ? mailcow : {};
  const installCfg = isObject(install) ? install : {};

  /** @type {{ ok: boolean; message?: string; admin_url?: string; guest_ip?: string | null; ct_ip?: string | null }} */
  let stackResult;

  if (mode === "proxmox-qemu" || mode === "configure-only") {
    const cfg = isObject(configure) ? configure : {};
    const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
    if (!host) {
      return { ok: false, system_id: systemId, message: "configure.ssh.host required" };
    }
    const q = isObject(px.qemu) ? px.qemu : {};
    const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
    errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} on ${hostId} (QEMU) …\n`);
    const exec = createConfigureExec("ssh", { user, host });
    stackResult = await maintainMailcowStackOnHost(exec, mailcowCfg, installCfg, { skipUpgrade });
  } else {
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
    }
    errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} on ${hostId} …\n`);
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    stackResult = await maintainMailcowStackInCt(
      pveSsh.user,
      pveSsh.host,
      vmid,
      mailcowCfg,
      installCfg,
      { skipUpgrade },
    );
  }

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
    rotateMailboxPasswords,
    apiKey,
    log: reconcileLog,
  });
  const domainResults = domainReconcile.domain_results;
  const dnsChecklists = domainReconcile.dns_checklists;
  const domainsSkipped = domainReconcile.domains_skipped;

  let baseline = { ok: true, skipped: true, message: "skipped" };
  if (!skipBaseline) {
    const log = provisionLogFromConsole(console);
    const vaultAccess = createPackageVaultAccess();
    const baselineFlags = { ...flags, "skip-mail-relay": "1" };

    if (mode === "proxmox-qemu" || mode === "configure-only") {
      const cfg = isObject(configure) ? configure : {};
      const ssh = isObject(cfg.ssh) ? cfg.ssh : {};
      const user = resolveGuestSshUser(ssh.user);
      const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
      const exec = createConfigureExec("ssh", { user, host });
      baseline = await ensureGuestLinuxBaseline({
        exec,
        log,
        flags: baselineFlags,
        vaultAccess,
        deployment: { systemId, system_id: systemId },
        proxmoxPackageRoot: proxmoxRoot,
      });
    } else {
      const lxc = isObject(px.lxc) ? px.lxc : {};
      const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
      const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
      const exec = createConfigureExec("pct", {
        user: pveSsh.user,
        host: pveSsh.host,
        vmid,
        pveHost: pveSsh.host,
      });
      baseline = await ensureGuestLinuxBaseline({
        exec,
        log,
        flags: baselineFlags,
        vaultAccess,
        deployment: { systemId, system_id: systemId },
        proxmoxPackageRoot: proxmoxRoot,
      });
    }
  }

  const domainsOk = domainsSkipped
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
  const vmidRaw =
    mode === "proxmox-qemu" || mode === "configure-only"
      ? isObject(px.qemu)
        ? typeof px.qemu.vmid === "number"
          ? px.qemu.vmid
          : Number(px.qemu.vmid)
        : null
      : isObject(px.lxc)
        ? typeof px.lxc.vmid === "number"
          ? px.lxc.vmid
          : Number(px.lxc.vmid)
        : null;

  return {
    ok: stackResult.ok && domainsOk && mailboxesOk && cloudflareDkimOk && baseline.ok,
    system_id: systemId,
    host_id: hostId,
    mode,
    vmid: Number.isFinite(vmidRaw) ? vmidRaw : null,
    skip_upgrade: skipUpgrade,
    skip_domains: skipDomains,
    skip_cloudflare_dkim: skipCloudflareDkim,
    skip_mailboxes: skipMailboxes,
    skip_aliases: skipAliases,
    prune,
    domains_skipped: domainsSkipped,
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
    dns_checklists: dnsChecklists,
    admin_url: stackResult.admin_url ?? null,
    guest_ip: stackResult.guest_ip ?? stackResult.ct_ip ?? null,
    ct_ip: stackResult.ct_ip ?? stackResult.guest_ip ?? null,
    message: stackResult.message,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh Mailcow stack (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
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
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainOne(deployment, flags, vault));
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
