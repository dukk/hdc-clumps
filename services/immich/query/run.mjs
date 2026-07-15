#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Query Immich deployments (config summary + optional live VM status).
 *
 * Usage: hdc run service immich query -- [--instance a | --system-id vm-immich-a]
 *        hdc run service immich query -- --live
 *        hdc run service immich query -- --system-id vm-immich-a --admin
 *        hdc run service immich query -- --system-id vm-immich-a --import --yes
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, relative } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  listImmichDeploymentSummaries,
  normalizeImmichConfig,
  resolveImmichDeployments,
} from "hdc/package/deployments.mjs";
import { queryImmichOnHost } from "hdc/package/query-status.mjs";
import { queryImmichOnSynology } from "hdc/package/immich-synology.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { diffSystemConfigSections, smtpSummaryFromSystemConfig } from "hdc/package/immich-admin-config.mjs";
import { fetchImmichAdminState } from "hdc/package/immich-admin-sync.mjs";
import { importImmichAdminToConfig } from "hdc/package/immich-import.mjs";
import { createImmichVaultAccess } from "hdc/package/vault-deps.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/immich/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function loadCfg() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  if (loaded.ok && loaded.data) {
    _pkgConfig = { data: loaded.data, path: loaded.path, source: loaded.source };
  }
  return loaded;
}

/**
 * @param {string} question
 */
async function confirm(question) {
  const rl = createInterface({ input, output: errout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const loaded = loadCfg();
  const rel = _pkgConfig
    ? relative(root, _pkgConfig.path).replace(/\\/g, "/")
    : CLUMP_CONFIG_EXAMPLE;
  const cfg = loaded.ok && isObject(loaded.data) ? loaded.data : null;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;
  const admin = flagGet(flags, "admin") !== undefined;
  const doImport = flagGet(flags, "import") !== undefined;
  const yes = flagGet(flags, "yes") !== undefined;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded.ok ? "loaded" : "not loaded"}.\n`);
  if (doImport) {
    errout.write(`[hdc] ${target} ${verb}: import will write sanitized immich.system_config to config.\n`);
  }

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;

  if (cfg) {
    try {
      const norm = normalizeImmichConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listImmichDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];
  /** @type {Record<string, unknown> | null} */
  let adminResult = null;

  if ((admin || doImport) && cfg && !configError) {
    let selected;
    try {
      selected = resolveImmichDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }

    if (selected && selected.length === 1) {
      const d = selected[0];
      const immich = isObject(d.immich) ? d.immich : {};
      const configure = isObject(d.configure) ? d.configure : {};
      const ssh = isObject(configure.ssh) ? configure.ssh : {};
      const sshHost = typeof ssh.host === "string" ? ssh.host.trim() : "";

      try {
        const vault = createImmichVaultAccess();
        errout.write(`[hdc] ${target} ${verb}: admin query ${d.systemId} …\n`);
        const state = await fetchImmichAdminState({
          vault,
          immich,
          sshHost: sshHost || null,
          log: (line) => errout.write(`${line}\n`),
        });

        const configured = immich.system_config;
        const driftSections = diffSystemConfigSections(configured, state.live);
        const hasDrift = driftSections.length > 0;

        /** @type {Record<string, unknown> | null} */
        let importMeta = null;
        if (doImport) {
          if (!yes) {
            const ok = await confirm(
              `Replace immich.system_config with live sanitized config (${Object.keys(state.live ?? {}).length} sections)? [y/N] `,
            );
            if (!ok) {
              errout.write(`[hdc] ${target} ${verb}: import aborted (use --yes to skip prompt).\n`);
              process.exitCode = 1;
              process.stdout.write(
                `${JSON.stringify({ ok: false, target, verb, message: "import not confirmed" }, null, 2)}\n`,
              );
              return;
            }
          }
          importMeta = importImmichAdminToConfig({
            clumpRoot,
            live: state.live,
            log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
          });
        }

        adminResult = {
          ok: true,
          system_id: d.systemId,
          api_reachable: true,
          api_base: state.api_base,
          has_drift: hasDrift,
          drift_sections: driftSections,
          smtp_summary: state.smtp_summary,
          configured_sections: isObject(configured) ? Object.keys(configured).sort() : [],
          import: importMeta,
        };
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        errout.write(`[hdc] ${target} ${verb}: admin query failed: ${msg}\n`);
        adminResult = {
          ok: false,
          system_id: d.systemId,
          api_reachable: false,
          message: msg,
          smtp_summary: smtpSummaryFromSystemConfig(null),
        };
      }
    } else if (selected && selected.length !== 1) {
      configError = "admin query/import requires exactly one deployment (--system-id)";
    }
  }

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveImmichDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
      for (const d of selected) {
        try {
          if (d.mode === "synology-docker") {
            errout.write(
              `[hdc] ${target} ${verb}: live query ${d.systemId} synology-docker …\n`,
            );
            const status = await queryImmichOnSynology(d);
            liveResults.push({
              system_id: d.systemId,
              mode: d.mode,
              ok: status.http_ok !== false && status.docker_active === "active",
              ...status,
            });
            continue;
          }

          const configure = isObject(d.configure) ? d.configure : {};
          const ssh = isObject(configure.ssh) ? configure.ssh : {};
          const user = resolveGuestSshUser(ssh.user);
          const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
          if (!host) {
            liveResults.push({
              system_id: d.systemId,
              ok: false,
              message: "missing configure.ssh.host",
            });
            continue;
          }
          errout.write(`[hdc] ${target} ${verb}: live query ${d.systemId} at ${user}@${host} …\n`);
          const exec = createConfigureExec("ssh", { user, host });
          const status = await queryImmichOnHost(exec, d.immich, d.install);
          liveResults.push({
            system_id: d.systemId,
            ok: status.http_ok !== false && status.docker_active === "active",
            ...status,
          });
        } catch (e) {
          liveResults.push({
            system_id: d.systemId,
            ok: false,
            message: String(/** @type {Error} */ (e).message || e),
          });
        }
      }
    }
  }

  const adminOk = adminResult ? adminResult.ok !== false : true;
  const payload = {
    ok: !configError && (loaded.ok || loaded.missing) && adminOk,
    target,
    verb,
    config_path: rel,
    config_loaded: loaded.ok,
    config_missing: Boolean(loaded.missing),
    config_parse_error: loaded.error ?? null,
    config_error: configError,
    schema_version: schemaVersion,
    deployments,
    live_requested: live,
    live: liveResults.length ? liveResults : undefined,
    admin_requested: admin || doImport,
    admin: adminResult ?? undefined,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = configError || !adminOk ? 1 : 0;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});

