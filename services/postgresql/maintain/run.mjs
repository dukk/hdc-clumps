#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
/**
 * Re-apply PostgreSQL configuration; optional package upgrade.
 *
 * Usage: hdc run service postgresql maintain -- [--instance a] [--skip-package-upgrade] [--skip-clamav]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import {
  configurePostgresqlServer,
  configurePostgresqlStandby,
  createConfigureExec,
} from "hdc/package/postgresql-configure.mjs";
import { aptInstallPostgresqlCommand } from "hdc/package/postgresql-install.mjs";
import {
  databasesForDeployment,
  findPrimaryDeployment,
  hasStandbyDeployments,
  normalizePostgresqlConfig,
  postgresqlGlobalSettings,
  resolvePostgresqlDeployments,
  rolesForDeployment,
  sshHostFromDeployment,
} from "hdc/package/deployments.mjs";
import { instanceLetterFromSystemId, replicationPasswordVaultKey, superuserPasswordVaultKey } from "hdc/package/inventory.mjs";
import { createPostgresqlVaultAccess } from "hdc/package/vault-deps.mjs";
import { postgresqlReportExtraSections } from "hdc/package/postgresql-report.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/postgresql/config.example.json";
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

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<typeof resolvePostgresqlDeployments>} allDeployments
 * @param {ReturnType<typeof resolvePostgresqlDeployments>[number]} primaryDeployment
 */
function standbyIpsForPrimary(allDeployments, primaryDeployment) {
  return allDeployments
    .filter(
      (d) =>
        d.role === "standby" && d.primarySystemId === primaryDeployment.systemId,
    )
    .map((d) => sshHostFromDeployment(d))
    .filter(Boolean);
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: PostgreSQL maintain (stderr log; JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const vaultAccess = createPackageVaultAccess();
  await vaultAccess.unlock({});
  const skipUpgrade = flagGet(flags, "skip-package-upgrade") !== undefined;

  let normalized;
  let allDeployments;
  let toMaintain;
  try {
    normalized = normalizePostgresqlConfig(cfg);
    allDeployments = resolvePostgresqlDeployments(cfg, {});
    toMaintain = resolvePostgresqlDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const global = postgresqlGlobalSettings(normalized);
  const vault = createPostgresqlVaultAccess();
  await vault.unlock({});

  const pgBlock = isObject(normalized.postgresql) ? normalized.postgresql : {};
  let replicationPassword = "";
  if (hasStandbyDeployments(allDeployments)) {
    const repKey = replicationPasswordVaultKey(pgBlock);
    replicationPassword = String(
      await vault.getSecret(repKey, { promptLabel: `vault secret ${repKey}` }),
    ).trim();
    if (!replicationPassword) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, target, verb, message: "missing replication password" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const log = provisionLogFromConsole(console);
  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const deployment of toMaintain) {
    const cfgSsh = deployment.configure;
    const ssh = isObject(cfgSsh) && isObject(cfgSsh.ssh) ? cfgSsh.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" ? ssh.host : "";
    if (!host) {
      results.push({ ok: false, system_id: deployment.systemId, message: "missing ssh host" });
      continue;
    }

    errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} (${deployment.role}) at ${user}@${host} …\n`);
    const letter = instanceLetterFromSystemId(deployment.systemId);
    const suKey = superuserPasswordVaultKey(pgBlock, letter);
    const superuserPassword = String(
      await vault.getSecret(suKey, { promptLabel: `vault secret ${suKey}` }),
    ).trim();
    if (!superuserPassword) {
      results.push({ ok: false, system_id: deployment.systemId, message: `missing ${suKey}` });
      continue;
    }

    const exec = createConfigureExec("ssh", { user, host });

    try {
      if (!skipUpgrade) {
        exec.run(aptInstallPostgresqlCommand(global.versionMajor), { capture: true });
      }

      let configure;
      if (deployment.role === "standby") {
        const primary = findPrimaryDeployment(allDeployments, deployment.primarySystemId);
        const primaryHost = primary ? sshHostFromDeployment(primary) : "";
        if (!primaryHost) {
          throw new Error("primary host not resolved");
        }
        configure = await configurePostgresqlStandby({
          exec,
          log,
          versionMajor: global.versionMajor,
          primaryHost,
          replicationUser: global.replicationUser,
          replicationPassword,
        });
      } else {
        const replicationEnabled =
          deployment.role === "primary" && hasStandbyDeployments(allDeployments);
        const resolveRolePassword = async (key, label) => {
          return String(await vault.getSecret(key, { promptLabel: `vault secret ${key} (${label})` })).trim();
        };
        configure = await configurePostgresqlServer({
          exec,
          log,
          versionMajor: global.versionMajor,
          superuserPassword,
          listenCidrs: global.listenCidrs,
          listenAddresses: global.listenAddresses,
          replicationEnabled,
          replicationUser: global.replicationUser,
          replicationPassword: replicationEnabled ? replicationPassword : "",
          standbyHostIps:
            deployment.role === "primary"
              ? standbyIpsForPrimary(allDeployments, deployment)
              : [],
          databases: databasesForDeployment(global, deployment),
          roles: rolesForDeployment(global, deployment),
          resolveRolePassword: rolesForDeployment(global, deployment).length
            ? resolveRolePassword
            : undefined,
        });
      }
      const baseline = await ensureGuestLinuxBaseline({ exec, log, flags, vaultAccess, deployment, proxmoxPackageRoot: proxmoxRoot });
      const rowOk = clamav.ok;
      results.push({
        ok: rowOk,
        system_id: deployment.systemId,
        role: deployment.role,
        configure,
        ...guestBaselineResultFields(baseline),
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      results.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  const payload = { ok, target, verb, results, generated_at: new Date().toISOString() };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    extraSections: postgresqlReportExtraSections,
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

