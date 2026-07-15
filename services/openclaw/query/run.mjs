#!/usr/bin/env node
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
/**
 * Query OpenClaw deployments (config summary + optional live status).
 *
 * Usage: hdc run service openclaw query -- [--instance a]
 *        hdc run service openclaw query -- --live
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listOpenclawDeploymentSummaries,
  normalizeOpenclawConfig,
  resolveOpenclawDeployments,
} from "hdc/package/deployments.mjs";
import { tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { queryOpenclawLive } from "hdc/package/query-status.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/openclaw/config.example.json";

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
  });
  const rel = loaded?.path
    ? relative(root, loaded.path).replace(/\\/g, "/")
    : CLUMP_CONFIG_EXAMPLE;
  const cfg = loaded?.ok && isObject(loaded.data) ? loaded.data : null;
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;

  errout.write(`[hdc] ${target} ${verb}: config ${rel} ${loaded?.ok ? "loaded" : "not loaded"}.\n`);

  /** @type {unknown[]} */
  let deployments = [];
  /** @type {string | null} */
  let configError = null;
  let schemaVersion = null;

  if (cfg) {
    try {
      const norm = normalizeOpenclawConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listOpenclawDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveOpenclawDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
      for (const d of selected) {
        const configure = isObject(d.configure) ? d.configure : {};
        const sshCfg = isObject(configure.ssh) ? configure.ssh : {};
        const sshUser = resolveGuestSshUser(sshCfg.user);
        const px = isObject(d.proxmox) ? d.proxmox : {};
        const q = isObject(px.qemu) ? px.qemu : {};
        const ip = typeof q.ip === "string" ? q.ip.trim() : "";
        const guestIp = ip.split("/")[0] || null;
        const sshHost =
          typeof sshCfg.host === "string" && sshCfg.host.trim()
            ? sshCfg.host.trim()
            : guestIp;

        /** @type {Record<string, unknown>} */
        const entry = {
          system_id: d.systemId,
          guest_ip: guestIp,
        };

        if (sshHost) {
          try {
            const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
            const status = await queryOpenclawLive(exec, d.openclaw, d.install, guestIp);
            Object.assign(entry, status);
          } catch (e) {
            entry.live_error = String(/** @type {Error} */ (e).message || e);
            entry.ok = false;
          }
        } else {
          entry.live_error = "ssh host unknown";
          entry.ok = false;
        }

        liveResults.push(entry);
      }
    }
  }

  const payload = {
    ok: !configError,
    target,
    verb,
    config_path: rel,
    schema_version: schemaVersion,
    config_error: configError,
    deployments,
    live: live ? liveResults : undefined,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = configError ? 1 : 0;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
