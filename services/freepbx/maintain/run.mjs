#!/usr/bin/env node
/**
 * Re-apply FreePBX NAT/RTP and Twilio trunk, then guest baseline.
 * Unattended-upgrades are skipped unless --enable-unattended-upgrades.
 * ClamAV scan is skipped unless --clamav-scan.
 *
 * Usage: hdc run service freepbx maintain -- [--instance a] [--skip-install]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { createGuestSshExec } from "hdc/package/guest-ssh-exec.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import { normalizeFreepbxConfig, resolveFreepbxDeployments } from "hdc/package/deployments.mjs";
import { applyFreepbx } from "hdc/package/freepbx-guest.mjs";
import { buildApplyPayload } from "hdc/package/freepbx-settings.mjs";
import { createFreepbxVaultAccess, resolveOrCreateSecret } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/freepbx/config.example.json";
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, string>} flags
 */
function baselineFlags(flags) {
  return {
    ...flags,
    "skip-unattended-upgrades": flags["enable-unattended-upgrades"] ? "" : "1",
    "skip-clamav-scan": flags["clamav-scan"] ? "" : "1",
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: re-apply FreePBX trunk and guest baseline.\n`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const cfg = ensurePackageConfig().data;
  const norm = normalizeFreepbxConfig(cfg);
  const deployments = resolveFreepbxDeployments(cfg, flags);
  const fp = norm.freepbx;
  const twilio = isObject(fp.twilio) ? fp.twilio : {};
  const adminKey =
    typeof fp.admin_password_vault_key === "string" && fp.admin_password_vault_key.trim()
      ? fp.admin_password_vault_key.trim()
      : "HDC_FREEPBX_ADMIN_PASSWORD";
  const userKey =
    typeof twilio.credential_username_vault_key === "string"
      ? twilio.credential_username_vault_key.trim()
      : "HDC_TWILIO_SIP_USERNAME";
  const passKey =
    typeof twilio.credential_password_vault_key === "string"
      ? twilio.credential_password_vault_key.trim()
      : "HDC_TWILIO_SIP_PASSWORD";
  const vaultAccess = createFreepbxVaultAccess(createNodeCliDeps());
  const secrets = {
    adminPassword: await resolveOrCreateSecret(vaultAccess, adminKey, { generate: true }),
    sipUsername: await resolveOrCreateSecret(vaultAccess, userKey),
    sipPassword: await resolveOrCreateSecret(vaultAccess, passKey),
  };
  const log = provisionLogFromConsole(console);
  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let allOk = true;

  for (const d of deployments) {
    try {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const q = isObject(px.qemu) ? px.qemu : {};
      const sshCfg = isObject(d.configure) && isObject(d.configure.ssh) ? d.configure.ssh : {};
      const ip = typeof q.ip === "string" ? q.ip.split("/")[0] : "";
      const sshHost = typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip;
      const sshUser = resolveGuestSshUser(sshCfg.user);
      if (!sshHost) throw new Error("configure.ssh.host or proxmox.qemu.ip required");
      logLine(`${d.systemId} via ${sshUser}@${sshHost}`);
      if (flagGet(flags, "skip-install", "skip_install") === undefined) {
        applyFreepbx({
          user: sshUser,
          host: sshHost,
          payload: buildApplyPayload({
            freepbx: fp,
            adminPassword: secrets.adminPassword,
            sipUsername: secrets.sipUsername,
            sipPassword: secrets.sipPassword,
          }),
          log: logLine,
        });
      }
      const exec = createGuestSshExec({ host: sshHost, configuredUser: sshUser, log: logLine });
      const baseline = await ensureGuestLinuxBaseline({
        exec,
        log,
        flags: baselineFlags(flags),
        vaultAccess,
        deployment: { ...d, proxmox: px },
        proxmoxPackageRoot: proxmoxRoot,
        clumpId: target,
        repoRoot: root,
      });
      results.push({
        ok: baseline.ok !== false,
        system_id: d.systemId,
        ip: sshHost,
        web_ui: `https://${sshHost}/`,
        ...guestBaselineResultFields(baseline),
      });
      if (baseline.ok === false) allOk = false;
    } catch (e) {
      allOk = false;
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${d.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: d.systemId, message: msg });
    }
  }

  const payload = { ok: allOk, target, verb, count: results.length, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok: allOk,
    log: logLine,
  });
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
