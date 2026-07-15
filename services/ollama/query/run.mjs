#!/usr/bin/env node
/**
 * Query Ollama deployments (config summary + optional live model list).
 *
 * Usage: hdc run service ollama query -- [--instance a]
 *        hdc run service ollama query -- --live
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  listOllamaDeploymentSummaries,
  normalizeOllamaConfig,
  resolveOllamaDeployments,
} from "hdc/package/deployments.mjs";
import {
  createOllamaExec,
  fetchOllamaModelsHttp,
  listOllamaModels,
  resolveOllamaApiBase,
} from "hdc/package/ollama-models.mjs";
import { tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { resolveUbuntuBootstrapSsh } from "../../../infrastructure/ubuntu/lib/ubuntu-ssh-resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/ollama/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
const ubuntuRoot = join(root, "clumps", "infrastructure", "ubuntu");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
  });
  if (loaded?.ok && loaded.data) {
    _pkgConfig = { data: loaded.data, path: loaded.path, source: loaded.source };
  }
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
      const norm = normalizeOllamaConfig(cfg);
      schemaVersion = norm.schemaVersion;
      deployments = listOllamaDeploymentSummaries(cfg);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
  }

  const defaultMode =
    cfg && isObject(cfg.defaults) && typeof cfg.defaults.mode === "string"
      ? cfg.defaults.mode
      : cfg && isObject(cfg.deploy) && typeof cfg.deploy.mode === "string"
        ? cfg.deploy.mode
        : null;

  /** @type {Record<string, unknown>[]} */
  const liveResults = [];

  if (live && cfg && !configError) {
    let selected;
    try {
      selected = resolveOllamaDeployments(cfg, flags);
    } catch (e) {
      configError = String(/** @type {Error} */ (e).message || e);
    }
    if (selected) {
      for (const d of selected) {
        const raw = isObject(d.raw) ? d.raw : {};
        const apiBase = resolveOllamaApiBase(raw);
        /** @type {Record<string, unknown>} */
        const entry = {
          system_id: d.systemId,
          configured_models: d.ollama?.models ?? [],
        };

        if (typeof apiBase === "string") {
          errout.write(`[hdc] ${target} ${verb}: live HTTP ${d.systemId} at ${apiBase} …\n`);
          const http = await fetchOllamaModelsHttp(apiBase);
          entry.api_base = apiBase;
          entry.live_models = http.models;
          entry.ok = http.ok;
          if (!http.ok) entry.error = http.error;
          if (!http.ok) {
            try {
              const exec = createOllamaExec(d, proxmoxRoot, ubuntuRoot);
              const listed = await listOllamaModels(exec);
              entry.live_models = listed.models;
              entry.ok = listed.ok;
              entry.via = "exec";
              if (!listed.ok) entry.error = listed.error;
            } catch (e) {
              entry.error = String(/** @type {Error} */ (e).message || e);
            }
          }
        } else if (apiBase && isObject(apiBase) && apiBase.bootstrap_host_id) {
          const bid = String(apiBase.bootstrap_host_id);
          const ssh = resolveUbuntuBootstrapSsh(ubuntuRoot, bid, process.env);
          if (ssh) {
            const port = typeof apiBase.port === "number" ? apiBase.port : 11434;
            const url = `http://${ssh.host}:${port}`;
            const http = await fetchOllamaModelsHttp(url);
            entry.api_base = url;
            entry.live_models = http.models;
            entry.ok = http.ok;
            if (!http.ok) entry.error = http.error;
          } else {
            entry.ok = false;
            entry.error = "ubuntu bootstrap SSH not resolved";
          }
        } else {
          try {
            const exec = createOllamaExec(d, proxmoxRoot, ubuntuRoot);
            const listed = await listOllamaModels(exec);
            entry.live_models = listed.models;
            entry.ok = listed.ok;
            entry.via = "exec";
            if (!listed.ok) entry.error = listed.error;
          } catch (e) {
            entry.ok = false;
            entry.error = String(/** @type {Error} */ (e).message || e);
          }
        }
        liveResults.push(entry);
      }
    }
  }

  const payload = {
    target,
    verb: "query",
    ok: Boolean(cfg) && !configError,
    config_path: rel,
    schema_version: schemaVersion,
    deploy_mode: defaultMode,
    deployments,
    live: live ? liveResults : undefined,
    config_error: configError,
    message: configError
      ? `Config error: ${configError}`
      : cfg
        ? `${deployments.length} deployment(s) configured (default mode=${JSON.stringify(defaultMode)}). Deploy all: hdc run service ollama deploy — or one: hdc run service ollama deploy -- --instance <letter>`
        : `Copy clumps/services/ollama/config.example.json to config.json (or hdc-private).`,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = payload.ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
