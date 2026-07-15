import { existsSync } from "node:fs";
import { join } from "node:path";

import { zonePassesFilter, resolveWorkerProjectDir } from "./workers-config.mjs";
import {
  buildPagesDeployArgv,
  buildPagesProjectCreateArgv,
  buildWorkerDeployArgv,
  runBuildCommand,
  runNpmInstall,
  runWrangler,
} from "./workers-wrangler.mjs";
import { applySecretSync, planSecretSync } from "./workers-sync.mjs";

/**
 * @param {object} opts
 * @param {import('./workers-config.mjs').NormalizedWorkersConfig} opts.config
 * @param {import('./workers-config.mjs').ConfigWorker} opts.worker
 * @param {string} opts.clumpRoot
 * @param {string} opts.token
 * @param {ReturnType<import('./workers-api.mjs').createCloudflareWorkersClient>} opts.workersApi
 * @param {Record<string, string>} opts.vaultSecrets
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.skipNpmInstall]
 * @param {(line: string) => void} [opts.log]
 */
export async function deployWorker(opts) {
  const log = opts.log ?? (() => {});
  const projectPath = resolveWorkerProjectDir(opts.clumpRoot, opts.worker.project_dir);
  const wranglerEnv = {
    CLOUDFLARE_API_TOKEN: opts.token,
    CLOUDFLARE_ACCOUNT_ID: opts.config.accountId,
  };

  if (opts.worker.npm_install && !opts.skipNpmInstall) {
    log(`worker ${opts.worker.id}: npm install in ${opts.worker.project_dir}`);
    const npm = runNpmInstall(projectPath, { dryRun: opts.dryRun });
    if (!npm.ok && !npm.skipped) {
      return {
        ok: false,
        id: opts.worker.id,
        script_name: opts.worker.script_name,
        error: `npm install failed (exit ${npm.status})`,
      };
    }
  }

  const args = buildWorkerDeployArgv(opts.worker, { dryRun: opts.dryRun });
  log(`worker ${opts.worker.id}: wrangler ${args.join(" ")}`);
  const wr = runWrangler({
    binary: opts.config.wranglerBinary,
    args,
    cwd: projectPath,
    env: wranglerEnv,
  });
  if (!wr.ok) {
    const detail = (wr.stderr || wr.stdout || wr.error?.message || "").trim().slice(0, 500);
    return {
      ok: false,
      id: opts.worker.id,
      script_name: opts.worker.script_name,
      error: `wrangler deploy failed (exit ${wr.status})${detail ? `: ${detail}` : ""}`,
    };
  }

  let secretsOk = true;
  /** @type {string[]} */
  const secretNotes = [];
  if (opts.worker.secrets.length) {
    const liveSecrets = await opts.workersApi.listWorkerSecrets(opts.worker.script_name);
    const secretPlan = planSecretSync(opts.worker.secrets, liveSecrets);
    const secretApply = await applySecretSync(
      opts.workersApi,
      opts.worker.script_name,
      secretPlan,
      opts.vaultSecrets,
      { dryRun: opts.dryRun, log }
    );
    secretsOk = secretApply.ok;
    secretNotes.push(
      ...secretApply.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`)
    );
  }

  return {
    ok: secretsOk,
    id: opts.worker.id,
    script_name: opts.worker.script_name,
    project_dir: opts.worker.project_dir,
    secrets_ok: secretsOk,
    notes: secretNotes,
  };
}

/**
 * @param {object} opts
 * @param {import('./workers-config.mjs').NormalizedWorkersConfig} opts.config
 * @param {import('./workers-config.mjs').ConfigPages} opts.page
 * @param {string} opts.clumpRoot
 * @param {string} opts.token
 * @param {ReturnType<import('./workers-api.mjs').createCloudflareWorkersClient>} opts.workersApi
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.skipBuild]
 * @param {boolean} [opts.skipNpmInstall]
 * @param {(line: string) => void} [opts.log]
 */
export async function deployPages(opts) {
  const log = opts.log ?? (() => {});
  const projectPath = resolveWorkerProjectDir(opts.clumpRoot, opts.page.project_dir);
  const wranglerEnv = {
    CLOUDFLARE_API_TOKEN: opts.token,
    CLOUDFLARE_ACCOUNT_ID: opts.config.accountId,
  };

  if (opts.page.npm_install && !opts.skipNpmInstall) {
    log(`pages ${opts.page.id}: npm install`);
    const npm = runNpmInstall(projectPath, { dryRun: opts.dryRun });
    if (!npm.ok && !npm.skipped) {
      return {
        ok: false,
        id: opts.page.id,
        project_name: opts.page.project_name,
        error: `npm install failed (exit ${npm.status})`,
      };
    }
  }

  if (opts.page.build_command && !opts.skipBuild) {
    log(`pages ${opts.page.id}: ${opts.page.build_command}`);
    const build = runBuildCommand(projectPath, opts.page.build_command, { dryRun: opts.dryRun });
    if (!build.ok && !build.skipped) {
      return {
        ok: false,
        id: opts.page.id,
        project_name: opts.page.project_name,
        error: `build failed (exit ${build.status})`,
      };
    }
  }

  const deployDir = join(projectPath, opts.page.deploy_dir);
  if (!opts.dryRun && !existsSync(deployDir)) {
    return {
      ok: false,
      id: opts.page.id,
      project_name: opts.page.project_name,
      error: `deploy_dir not found: ${opts.page.deploy_dir}`,
    };
  }

  if (opts.page.create_project && !opts.dryRun) {
    const exists = await opts.workersApi.pagesProjectExists(opts.page.project_name);
    if (!exists) {
      log(`pages ${opts.page.id}: creating project ${opts.page.project_name}`);
      const createArgs = buildPagesProjectCreateArgv(opts.page.project_name);
      const create = runWrangler({
        binary: opts.config.wranglerBinary,
        args: createArgs,
        cwd: projectPath,
        env: wranglerEnv,
      });
      if (!create.ok) {
        const detail = (create.stderr || create.stdout || "").trim().slice(0, 300);
        return {
          ok: false,
          id: opts.page.id,
          project_name: opts.page.project_name,
          error: `pages project create failed${detail ? `: ${detail}` : ""}`,
        };
      }
    }
  }

  const args = buildPagesDeployArgv(opts.page, { dryRun: opts.dryRun });
  log(`pages ${opts.page.id}: wrangler ${args.join(" ")}`);
  const wr = runWrangler({
    binary: opts.config.wranglerBinary,
    args,
    cwd: projectPath,
    env: wranglerEnv,
  });
  if (!wr.ok) {
    const detail = (wr.stderr || wr.stdout || wr.error?.message || "").trim().slice(0, 500);
    return {
      ok: false,
      id: opts.page.id,
      project_name: opts.page.project_name,
      error: `wrangler pages deploy failed (exit ${wr.status})${detail ? `: ${detail}` : ""}`,
    };
  }

  return {
    ok: true,
    id: opts.page.id,
    project_name: opts.page.project_name,
    project_dir: opts.page.project_dir,
    deploy_dir: opts.page.deploy_dir,
  };
}

/**
 * @param {ReturnType<typeof import('./workers-api.mjs').createCloudflareWorkersClient>} workersApi
 * @param {ReturnType<typeof import('../../cloudflare/lib/cloudflare-api.mjs').createCloudflareClient>} dnsApi
 * @param {import('./workers-config.mjs').ConfigWorker} worker
 * @param {import('./workers-config.mjs').NormalizedWorkersConfig} config
 */
export async function listWorkerRoutesByZone(workersApi, dnsApi, worker, config) {
  const zones = await dnsApi.listZones();
  const zoneByName = new Map(zones.map((z) => [z.name, z]));
  /** @type {{ zone_name: string; zone_id: string; routes: import('./workers-api.mjs').CfWorkerRoute[] }[]} */
  const out = [];
  for (const route of worker.routes) {
    if (!zonePassesFilter(route.zone_name, config.zoneFilter)) continue;
    let entry = out.find((e) => e.zone_name === route.zone_name);
    if (!entry) {
      const zone = zoneByName.get(route.zone_name);
      entry = {
        zone_name: route.zone_name,
        zone_id: zone?.id ?? "",
        routes: zone ? await workersApi.listWorkerRoutes(zone.id) : [],
      };
      out.push(entry);
    }
  }
  return out;
}
