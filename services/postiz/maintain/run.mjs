#!/usr/bin/env node
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Maintain Postiz: upgrade, rebuild, or restart services + ClamAV baseline.
 *
 * Usage: hdc run service postiz maintain -- [--instance a] [--skip-upgrade] [--rebuild] [--check-latest] [--version vX.Y.Z] [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { resolvePostizDeployments } from "hdc/package/deployments.mjs";
import { maintainPostizInCt, resolvePveSshForHost } from "hdc/package/postiz-install.mjs";
import { createPostizVaultAccess } from "hdc/package/vault-deps.mjs";
import { resolvePostizSecrets } from "hdc/package/vault-secrets.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/postiz/config.example.json";
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
 * @param {ReturnType<typeof resolvePostizDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {{ dbPassword: string; jwtSecret: string }} secrets
 */
async function maintainOne(deployment, flags, secrets, vaultAccess) {
  const { systemId, proxmox: px, postiz, install } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;
  const rebuild = flagGet(flags, "rebuild") !== undefined;
  const checkLatest = flagGet(flags, "check-latest", "check_latest") !== undefined;
  const versionOverride = flagGet(flags, "version");

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
  const postizCfg = isObject(postiz) ? postiz : {};
  const installCfg = isObject(install) ? install : {};
  const result = await maintainPostizInCt(
    pveSsh.user,
    pveSsh.host,
    vmid,
    postizCfg,
    installCfg,
    secrets.dbPassword,
    secrets.jwtSecret,
    { skipUpgrade, rebuild, checkLatest, versionOverride: versionOverride ?? undefined },
  );

  const log = provisionLogFromConsole(console);
  const exec = createConfigureExec("pct", {
    user: pveSsh.user,
    host: pveSsh.host,
    vmid,
    pveHost: pveSsh.host,
  });
  const baseline = await ensureGuestLinuxBaseline({ exec, log, flags, vaultAccess, deployment, proxmoxPackageRoot: proxmoxRoot });

  return {
    ok: result.ok && baseline.ok,
    system_id: systemId,
    host_id: hostId,
    vmid,
    skip_upgrade: skipUpgrade,
    rebuild,
    access_url: result.access_url ?? null,
    upgraded: result.upgraded,
    rebuilt: result.rebuilt,
    installed_version: result.installed_version,
    target_version: result.target_version,
    message: result.message,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Postiz maintain (stderr log; JSON on stdout).\n`);

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
    deployments = resolvePostizDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createPostizVaultAccess();
  const defaultsPz =
    isObject(cfg.defaults) && isObject(cfg.defaults.postiz) ? cfg.defaults.postiz : {};
  const secrets = await resolvePostizSecrets(vault, defaultsPz);

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

