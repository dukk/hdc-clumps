#!/usr/bin/env node
/**
 * Maintain Open WebUI: re-push .env from config, refresh Docker images, recreate containers.
 *
 * Usage: hdc run service open-webui maintain -- [--instance a | --system-id open-webui-a]
 *        hdc run service open-webui maintain -- [--skip-upgrade]
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { guestBaselineResultFields, guestBaselineUsersOk } from "hdc/package/guest-baseline-report.mjs";
import { ensureGuestLinuxBaseline } from "hdc/package/guest-linux-baseline.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  resolveOpenWebuiDeployments,
  secretKeyVaultKeyFromConfig,
} from "hdc/package/deployments.mjs";
import { maintainOpenWebuiInCt, resolvePveSshForHost } from "hdc/package/open-webui-install.mjs";
import { normalizeOpenaiBackends } from "hdc/package/open-webui-render.mjs";
import { createOpenWebuiVaultAccess } from "hdc/package/vault-deps.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/open-webui/config.example.json";
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
 * @param {ReturnType<typeof resolveOpenWebuiDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {string} secretKey
 * @param {Record<string, string>} openaiKeysById
 * @param {ReturnType<typeof createPackageVaultAccess>} vaultAccess
 */
async function maintainOne(deployment, flags, secretKey, openaiKeysById, vaultAccess) {
  const { systemId, proxmox: px, openWebui, install } = deployment;
  const skipUpgrade = flagGet(flags, "skip-upgrade", "skip_upgrade") !== undefined;

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
  const openWebuiCfg = isObject(openWebui) ? openWebui : {};
  const installCfg = isObject(install) ? install : {};
  const result = await maintainOpenWebuiInCt(
    pveSsh.user,
    pveSsh.host,
    vmid,
    openWebuiCfg,
    installCfg,
    secretKey,
    { skipUpgrade, openaiKeysById },
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
    web_ui_url: result.web_ui_url ?? null,
    message: result.message,
    ...guestBaselineResultFields(baseline),
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: refresh Open WebUI Docker stack (stderr log; JSON on stdout).\n`);

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
    deployments = resolveOpenWebuiDeployments(cfg, flags);
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const vault = createOpenWebuiVaultAccess();
  const defaultsOw =
    isObject(cfg.defaults) && isObject(cfg.defaults.open_webui) ? cfg.defaults.open_webui : {};
  const skKey = secretKeyVaultKeyFromConfig(defaultsOw);
  errout.write(`[hdc] ${target} ${verb}: loading secret from vault ${skKey} …\n`);
  await vault.unlock({});
  const secretKey = String(
    await vault.getSecret(skKey, { promptLabel: `vault secret ${skKey}` }),
  ).trim();
  if (!secretKey) {
    errout.write(`[hdc] ${target} ${verb}: secret required — set vault ${skKey}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: `missing vault ${skKey}` }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, string>} */
  const openaiKeysById = {};
  /** @type {Map<string, string>} */
  const openaiVaultKeyValues = new Map();
  for (const deployment of deployments) {
    const ow = isObject(deployment.openWebui) ? deployment.openWebui : {};
    for (const b of normalizeOpenaiBackends(ow.openai_backends)) {
      if (!openaiVaultKeyValues.has(b.api_key_vault_key)) {
        errout.write(
          `[hdc] ${target} ${verb}: loading OpenAI API key from vault ${b.api_key_vault_key} …\n`,
        );
        const val = String(
          await vault.getSecret(b.api_key_vault_key, {
            promptLabel: `vault secret ${b.api_key_vault_key}`,
          }),
        ).trim();
        if (!val) {
          errout.write(
            `[hdc] ${target} ${verb}: secret required — set vault ${b.api_key_vault_key}\n`,
          );
          process.stdout.write(
            `${JSON.stringify({ ok: false, target, verb, message: `missing vault ${b.api_key_vault_key}` }, null, 2)}\n`,
          );
          process.exitCode = 1;
          return;
        }
        openaiVaultKeyValues.set(b.api_key_vault_key, val);
      }
      openaiKeysById[b.id] = /** @type {string} */ (openaiVaultKeyValues.get(b.api_key_vault_key));
    }
  }

  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await maintainOne(deployment, flags, secretKey, openaiKeysById, vaultAccess));
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
