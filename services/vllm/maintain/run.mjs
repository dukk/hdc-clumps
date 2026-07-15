#!/usr/bin/env node
/**
 * Maintain vLLM: re-push compose + .env, docker compose pull/up, guest Linux baseline.
 *
 * Usage: hdc run service vllm maintain -- [--instance a | --system-id vm-vllm-a]
 *        hdc run service vllm maintain -- [--skip-upgrade] [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { guestBaselineResultFields } from "hdc/package/guest-baseline-report.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { resolveVllmDeployments } from "hdc/package/deployments.mjs";
import { maintainVllmViaSsh } from "hdc/package/vllm-install.mjs";
import { createVllmVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolveVllmSecrets } from "hdc/package/vault-secrets.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/vllm/config.example.json";
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
 * @param {ReturnType<typeof resolveVllmDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {{ hfToken: string }} secrets
 * @param {ReturnType<typeof createPackageVaultAccess>} vaultAccess
 */
async function maintainQemuOne(deployment, flags, secrets, vaultAccess) {
  const { systemId, mode, proxmox: px, configure, install, vllm } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  const log = provisionLogFromConsole(console);

  if (mode !== "proxmox-qemu") {
    return { ok: false, system_id: systemId, message: `unsupported mode ${mode}` };
  }

  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const sshCfg = isObject(configure) && isObject(configure.ssh) ? configure.ssh : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const sshUser = resolveGuestSshUser(sshCfg.user);
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim() ? sshCfg.host.trim() : ip.split("/")[0];
  if (!sshHost) {
    return { ok: false, system_id: systemId, message: "configure.ssh.host or proxmox.qemu.ip required" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} QEMU via ${sshUser}@${sshHost} …\n`);
  const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
  const vllmCfg = isObject(vllm) ? vllm : {};
  const installCfg = isObject(install) ? install : {};

  let stackResult;
  try {
    stackResult = await maintainVllmViaSsh({
      exec,
      log,
      install: installCfg,
      vllm: vllmCfg,
      hfToken: secrets.hfToken,
      guestIp: sshHost,
      skipUpgrade,
    });
  } catch (e) {
    return {
      ok: false,
      system_id: systemId,
      message: String(/** @type {Error} */ (e).message || e),
    };
  }

  const baseline = await ensureGuestLinuxBaseline({
    exec,
    log,
    flags,
    vaultAccess,
    deployment,
    proxmoxPackageRoot: proxmoxRoot,
  });

  return {
    ok: stackResult.ok && baseline.ok,
    system_id: systemId,
    mode,
    skip_upgrade: skipUpgrade,
    url: stackResult.url ?? null,
    upstream_url: stackResult.upstream_url ?? null,
    message: stackResult.message,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh vLLM Docker stack (stderr log; JSON on stdout).\n`);

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
    deployments = resolveVllmDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createVllmVaultAccess();
  const defaultsVllm =
    isObject(cfg.defaults) && isObject(cfg.defaults.vllm) ? cfg.defaults.vllm : {};
  let secrets;
  try {
    secrets = await resolveVllmSecrets(vault, defaultsVllm);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: ${msg}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (deployments.length > 1) {
    errout.write(`[hdc] ${target} ${verb}: maintaining ${deployments.length} instance(s) …\n`);
  }

  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainQemuOne(deployment, flags, secrets, vaultAccess));
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
