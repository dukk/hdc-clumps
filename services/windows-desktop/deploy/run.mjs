#!/usr/bin/env node
/**
 * Deploy Windows 11 desktop on Proxmox QEMU (ISO install, template build, or clone).
 *
 * Usage: hdc run service windows-desktop deploy -- [--instance a | --system-id vm-win11-a]
 *        [--build-template] [--force-rebuild-template] [--refresh-iso]
 *        [--destroy-existing] [--skip-provision] [--skip-oem] [--skip-install] [--skip-sysprep]
 *        [--wait-install] [--install-timeout-minutes 90]
 *        [--skip-existing | --redeploy-existing]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet, flagNumber } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

import {
  adminVaultKey,
  normalizeWindowsDesktopConfig,
  resolveWindowsDesktopDeployments,
} from "hdc/package/deployments.mjs";
import { deployWindowsCloneInstance } from "hdc/package/windows-clone-deploy.mjs";
import { deployWindowsIsoInstance } from "hdc/package/windows-iso-deploy.mjs";
import { buildWindowsTemplate } from "hdc/package/windows-template-build.mjs";
import { createWindowsDesktopVaultAccess, resolveAdminPassword } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/windows-desktop/config.example.json";
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

function skipProvision(flags) {
  return flagGet(flags, "skip-provision") !== undefined;
}

function buildTemplateFlag(flags) {
  return flagGet(flags, "build-template", "build_template") !== undefined;
}

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  const log = provisionLogFromConsole(console);
  const deps = createNodeCliDeps();
  const cfg = ensurePackageConfig().data;
  const normalized = normalizeWindowsDesktopConfig(cfg);
  const installTimeoutMinutes = flagNumber(flagGet(flags, "install-timeout-minutes"), 90) ?? 90;

  errout.write(`[hdc] ${target} ${verb}: Windows 11 QEMU deploy (stderr log; JSON on stdout).\n`);

  if (skipProvision(flags)) {
    errout.write(`[hdc] ${target} ${verb}: --skip-provision set — nothing to do.\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: true, target, verb, skipped: true }, null, 2)}\n`,
    );
    return;
  }

  const vault = createWindowsDesktopVaultAccess(deps);
  await vault.unlock({});

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  try {
    const deployments = resolveWindowsDesktopDeployments(cfg, flags);
    const adminKey = adminVaultKey(deployments[0]);
    const adminPassword = await resolveAdminPassword(vault, adminKey, deps.readLineQuestion);
    const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);

    if (buildTemplateFlag(flags)) {
      const templateDeployment = deployments[0];
      try {
        const r = await buildWindowsTemplate({
          normalized,
          deployment: templateDeployment,
          adminPassword,
          flags,
          proxmoxRoot,
          deps,
          installTimeoutMinutes: Math.max(installTimeoutMinutes, 120),
          log: logLine,
        });
        results.push(r);
        if (!r.ok) ok = false;
      } catch (e) {
        ok = false;
        const msg = String(/** @type {Error} */ (e).message || e);
        logLine(`template build failed: ${msg}`);
        results.push({ ok: false, action: "build-template", message: msg });
      }
    } else {
      for (const deployment of deployments) {
        try {
          const common = {
            deployment,
            adminPassword,
            flags,
            proxmoxRoot,
            repoRoot: root,
            target,
            verb,
            installTimeoutMinutes,
            log: logLine,
          };
          const r =
            deployment.mode === "proxmox-qemu-clone"
              ? await deployWindowsCloneInstance(common)
              : await deployWindowsIsoInstance(common);
          results.push(r);
          if (!r.ok) ok = false;
        } catch (e) {
          ok = false;
          const msg = String(/** @type {Error} */ (e).message || e);
          logLine(`${deployment.systemId} failed: ${msg}`);
          results.push({ ok: false, system_id: deployment.systemId, message: msg });
        }
      }
    }
  } catch (e) {
    ok = false;
    errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).message || e}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const payload = { ok, target, verb, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  await runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  process.exitCode = ok ? 0 : 1;
}

main();
