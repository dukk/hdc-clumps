#!/usr/bin/env node
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
/**
 * Maintain paperless-ngx: re-push compose + env from config, refresh Docker images, guest baseline.
 *
 * Usage: hdc run service paperless-ngx maintain -- [--instance a | --system-id paperless-ngx-a]
 *        hdc run service paperless-ngx maintain -- [--skip-upgrade] [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { resolvePaperlessNgxDeployments } from "hdc/package/deployments.mjs";
import {
  maintainPaperlessNgxInCt,
  maintainPaperlessNgxInQemu,
  resolvePveSshForHost,
} from "hdc/package/paperless-ngx-install.mjs";
import { createPaperlessNgxVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolvePaperlessNgxSecrets } from "hdc/package/vault-secrets.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/paperless-ngx/config.example.json";
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
 * @param {ReturnType<typeof resolvePaperlessNgxDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {{ secretKey: string; dbPassword: string; adminPassword?: string | null }} secrets
 * @param {ReturnType<typeof createPackageVaultAccess>} vaultAccess
 */
async function maintainOne(deployment, flags, secrets, vaultAccess) {
  const { systemId, mode, proxmox: px, configure, paperless_ngx, install } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) {
    return { ok: false, system_id: systemId, message: "missing host_id" };
  }

  const paperlessCfg = isObject(paperless_ngx) ? paperless_ngx : {};
  const installCfg = isObject(install) ? install : {};
  const log = provisionLogFromConsole(console);

  if (mode === "proxmox-qemu") {
    const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
    const q = isObject(px.qemu) ? px.qemu : {};
    const sshUser = resolveGuestSshUser(sshCfg.user);
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    const sshHost =
      typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];
    if (!sshHost) {
      return { ok: false, system_id: systemId, message: "configure.ssh.host or proxmox.qemu.ip required" };
    }

    errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${sshUser}@${sshHost} …\n`);
    const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
    const result = await maintainPaperlessNgxInQemu({
      exec,
      paperless: paperlessCfg,
      install: installCfg,
      secrets,
      maintainOpts: { skipUpgrade },
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
      mode,
      skip_upgrade: skipUpgrade,
      tika_enabled: result.tika_enabled ?? null,
      url: result.url ?? null,
      upstream_url: result.upstream_url ?? null,
      message: result.message,
      ...guestBaselineResultFields(baseline),
    };
  }

  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, host_id: hostId, message: "invalid vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} vmid ${vmid} on ${hostId} …\n`);
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const result = await maintainPaperlessNgxInCt(
    pveSsh.user,
    pveSsh.host,
    vmid,
    paperlessCfg,
    installCfg,
    secrets,
    { skipUpgrade },
  );

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
    mode,
    vmid,
    skip_upgrade: skipUpgrade,
    tika_enabled: result.tika_enabled ?? null,
    url: result.url ?? null,
    upstream_url: result.upstream_url ?? null,
    message: result.message,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh paperless-ngx Docker stack (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing — see stderr" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  let deployments;
  try {
    deployments = resolvePaperlessNgxDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createPaperlessNgxVaultAccess();
  const defaultsPaperless =
    isObject(cfg.defaults) && isObject(cfg.defaults.paperless_ngx) ? cfg.defaults.paperless_ngx : {};
  let secrets;
  try {
    secrets = await resolvePaperlessNgxSecrets(vault, defaultsPaperless);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

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
