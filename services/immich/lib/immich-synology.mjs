import { join } from "node:path";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { createSynologyExecContext } from "../../../infrastructure/synology-nas/lib/synology-exec-context.mjs";
import {
  composeDirFromStack,
  deployComposeStack,
  maintainComposeStack,
  teardownComposeStack,
} from "../../../infrastructure/synology-nas/lib/synology-docker-compose.mjs";
import { synologyRemoteExec } from "../../../infrastructure/synology-nas/lib/synology-ssh.mjs";
import {
  composeDir,
  composeFileUrl,
  renderImmichEnv,
  resolvePublicUrl,
} from "./immich-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} synologyCfg
 * @param {Record<string, unknown>} synologyBlock
 */
function composeBaseDir(synologyCfg, synologyBlock) {
  if (isObject(synologyBlock) && typeof synologyBlock.compose_base_dir === "string") {
    const t = synologyBlock.compose_base_dir.trim();
    if (t) return t;
  }
  const defaults = isObject(synologyCfg.defaults) ? synologyCfg.defaults : {};
  const docker = isObject(defaults.docker) ? defaults.docker : {};
  return typeof docker.compose_base_dir === "string" && docker.compose_base_dir.trim()
    ? docker.compose_base_dir.trim()
    : "/volume1/docker";
}

/**
 * @param {ReturnType<import("./deployments.mjs").finalizeDeployment>} deployment
 * @param {Record<string, unknown>} synologyCfg
 */
export function resolveSynologyComposeDir(deployment, synologyCfg) {
  const installDir = composeDir(deployment.install);
  if (installDir && installDir !== "/opt/immich") {
    return installDir;
  }
  const syn = deployment.synology;
  const stackId =
    isObject(syn) && typeof syn.stack_id === "string" && syn.stack_id.trim()
      ? syn.stack_id.trim()
      : "immich";
  return composeDirFromStack(stackId, composeBaseDir(synologyCfg, syn));
}

/**
 * @param {string} release
 */
export async function fetchImmichComposeYaml(release) {
  const url = composeFileUrl(release);
  errout.write(`[hdc] immich synology: fetching compose from ${url} …\n`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch compose failed: HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/**
 * @param {ReturnType<import("./deployments.mjs").finalizeDeployment>} deployment
 * @param {{ readLineQuestion?: (q: string, o?: { mask?: boolean }) => Promise<string>; warn?: (s: string) => void; log?: (s: string) => void }} [deps]
 */
export async function loadSynologyConfig(deployment, deps = {}) {
  const root = repoRoot();
  const synologyRoot = join(root, "clumps", "infrastructure", "synology-nas");
  const loaded = loadClumpConfigFromClumpRoot(synologyRoot, {
    exampleRel: "clumps/infrastructure/synology-nas/config.example.json",
  });
  const syn = deployment.synology;
  const instance =
    isObject(syn) && typeof syn.instance === "string" && syn.instance.trim()
      ? syn.instance.trim()
      : "a";
  const ctx = await createSynologyExecContext({
    cfg: loaded.data,
    flags: { instance },
    deps,
  });
  return { synologyCfg: loaded.data, ...ctx };
}

/**
 * @param {ReturnType<import("./deployments.mjs").finalizeDeployment>} deployment
 * @param {string} dbPassword
 * @param {{ readLineQuestion?: (q: string, o?: { mask?: boolean }) => Promise<string>; warn?: (s: string) => void; log?: (s: string) => void }} [deps]
 */
export async function deployImmichOnSynology(deployment, dbPassword, deps = {}) {
  const { synologyCfg, execOpts, log, target } = await loadSynologyConfig(deployment, deps);

  if (deployment.install.enabled === false) {
    errout.write(`[hdc] immich synology: ${deployment.systemId} install disabled — skipping.\n`);
    return { ok: true, skipped: true, message: "install disabled" };
  }

  const release = typeof deployment.immich.release === "string" ? deployment.immich.release : "latest";
  const dir = resolveSynologyComposeDir(deployment, synologyCfg);
  const envContent = renderImmichEnv(deployment.immich, deployment.install, dbPassword);
  const composeYaml = await fetchImmichComposeYaml(release);

  const upload =
    typeof deployment.immich.upload_location === "string"
      ? deployment.immich.upload_location.trim()
      : "";
  const dbLoc =
    typeof deployment.immich.db_data_location === "string"
      ? deployment.immich.db_data_location.trim()
      : "";
  const mkdirScript = [
    "set -euo pipefail",
    upload ? `mkdir -p '${upload.replace(/'/g, `'\\''`)}'` : "",
    dbLoc ? `mkdir -p '${dbLoc.replace(/'/g, `'\\''`)}'` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (mkdirScript) {
    const mr = synologyRemoteExec(execOpts, mkdirScript);
    if (mr.status !== 0) {
      const detail = `${mr.stderr}${mr.stdout}`.trim() || `exit ${mr.status}`;
      return { ok: false, message: `mkdir storage paths: ${detail}` };
    }
  }

  const result = await deployComposeStack(
    execOpts,
    { dir, composeYaml, envContent, pull: true },
    log,
    { ensureDocker: true },
  );

  const webUrl = resolvePublicUrl(deployment.immich, target.host);
  return {
    ...result,
    compose_dir: dir,
    web_url: webUrl,
    host: target.host,
  };
}

/**
 * @param {ReturnType<import("./deployments.mjs").finalizeDeployment>} deployment
 * @param {string} dbPassword
 * @param {{ skipUpgrade?: boolean }} [opts]
 * @param {{ readLineQuestion?: (q: string, o?: { mask?: boolean }) => Promise<string>; warn?: (s: string) => void; log?: (s: string) => void }} [deps]
 */
export async function maintainImmichOnSynology(deployment, dbPassword, opts = {}, deps = {}) {
  const { synologyCfg, execOpts, log } = await loadSynologyConfig(deployment, deps);
  const dir = resolveSynologyComposeDir(deployment, synologyCfg);
  const envContent = renderImmichEnv(deployment.immich, deployment.install, dbPassword);

  const result = await maintainComposeStack(
    execOpts,
    { dir, envContent, pull: !opts.skipUpgrade },
    log,
  );

  const host = execOpts.target.host;
  return {
    ...result,
    web_url: resolvePublicUrl(deployment.immich, host),
  };
}

/**
 * @param {ReturnType<import("./deployments.mjs").finalizeDeployment>} deployment
 * @param {{ removeVolumes?: boolean }} [opts]
 * @param {{ readLineQuestion?: (q: string, o?: { mask?: boolean }) => Promise<string>; warn?: (s: string) => void; log?: (s: string) => void }} [deps]
 */
export async function teardownImmichOnSynology(deployment, opts = {}, deps = {}) {
  const { synologyCfg, execOpts, log } = await loadSynologyConfig(deployment, deps);
  const dir = resolveSynologyComposeDir(deployment, synologyCfg);
  return teardownComposeStack(
    execOpts,
    { dir, removeVolumes: opts.removeVolumes === true },
    log,
  );
}

/**
 * @param {ReturnType<import("./deployments.mjs").finalizeDeployment>} deployment
 * @param {{ readLineQuestion?: (q: string, o?: { mask?: boolean }) => Promise<string>; warn?: (s: string) => void; log?: (s: string) => void }} [deps]
 */
export async function queryImmichOnSynology(deployment, deps = {}) {
  const { synologyCfg, execOpts, target } = await loadSynologyConfig(deployment, deps);
  const port =
    typeof deployment.immich.port === "number" && Number.isFinite(deployment.immich.port)
      ? deployment.immich.port
      : 2283;
  const dir = resolveSynologyComposeDir(deployment, synologyCfg);

  const docker = synologyRemoteExec(
    execOpts,
    "docker info >/dev/null 2>&1 && echo active || echo inactive",
  );
  const composePs = synologyRemoteExec(
    execOpts,
    `test -d '${dir.replace(/'/g, `'\\''`)}' && cd '${dir.replace(/'/g, `'\\''`)}' && docker compose ps 2>/dev/null || echo ''`,
  );

  let httpOk = null;
  let httpError = null;
  if (docker.stdout.trim() === "active") {
    const healthCmd = `curl -sf --max-time 10 http://127.0.0.1:${port}/api/server/ping -o /dev/null && echo ok || echo fail`;
    const h = synologyRemoteExec(execOpts, healthCmd);
    if (h.status === 0 && h.stdout.trim() === "ok") {
      httpOk = true;
    } else {
      httpOk = false;
      httpError = `${h.stderr}${h.stdout}`.trim() || `exit ${h.status}`;
    }
  }

  return {
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    host: target.host,
    http_ok: httpOk,
    http_error: httpError,
    port,
    ui_url: `http://${target.host}:${port}`,
    compose_dir: dir,
  };
}
