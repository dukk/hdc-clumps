import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * @param {string} binary
 * @param {typeof spawnSync} [spawnFn]
 */
export function checkWranglerAvailable(binary, spawnFn = spawnSync) {
  const r = spawnFn(binary, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
    shell: process.platform === "win32",
  });
  if (r.error) {
    throw new Error(
      `wrangler not found (${binary}). Install with: npm install -g wrangler — or add wrangler as a devDependency in the worker project.`
    );
  }
  if (r.status !== 0) {
    throw new Error(`wrangler --version failed (exit ${r.status})`);
  }
  return (r.stdout ?? r.stderr ?? "").trim();
}

/**
 * @param {import('./workers-config.mjs').ConfigWorker} worker
 * @param {{ dryRun?: boolean }} [opts]
 */
export function buildWorkerDeployArgv(worker, opts = {}) {
  /** @type {string[]} */
  const args = ["deploy"];
  if (opts.dryRun) args.push("--dry-run");
  if (worker.wrangler_env) {
    args.push("--env", worker.wrangler_env);
  }
  return args;
}

/**
 * @param {import('./workers-config.mjs').ConfigPages} page
 * @param {{ dryRun?: boolean }} [opts]
 */
export function buildPagesDeployArgv(page, opts = {}) {
  const deployPath = page.deploy_dir;
  /** @type {string[]} */
  const args = ["pages", "deploy", deployPath, "--project-name", page.project_name];
  if (page.production_branch) {
    args.push("--branch", page.production_branch);
  }
  if (opts.dryRun) args.push("--dry-run");
  return args;
}

/**
 * @param {string} binary
 */
export function buildPagesProjectCreateArgv(projectName) {
  return ["pages", "project", "create", projectName, "--production-branch", "main"];
}

/**
 * @param {string} scriptName
 */
export function buildWorkerDeleteArgv(scriptName) {
  return ["delete", scriptName, "--force"];
}

/**
 * @param {string} projectName
 */
export function buildPagesProjectDeleteArgv(projectName) {
  return ["pages", "project", "delete", projectName];
}

/**
 * @param {object} opts
 * @param {string} opts.binary
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {Record<string, string>} opts.env
 * @param {typeof spawnSync} [opts.spawnFn]
 */
export function runWrangler(opts) {
  const spawnFn = opts.spawnFn ?? spawnSync;
  const r = spawnFn(opts.binary, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    timeout: 600_000,
    shell: process.platform === "win32",
  });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

/**
 * @param {string} cwd
 * @param {{ spawnFn?: typeof spawnSync; dryRun?: boolean }} [opts]
 */
export function runNpmInstall(cwd, opts = {}) {
  if (opts.dryRun) return { ok: true, skipped: true };
  const pkg = join(cwd, "package.json");
  if (!existsSync(pkg)) return { ok: true, skipped: true };

  const spawnFn = opts.spawnFn ?? spawnSync;
  const r = spawnFn("npm", ["install"], {
    cwd,
    encoding: "utf8",
    timeout: 600_000,
    shell: process.platform === "win32",
  });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    skipped: false,
  };
}

/**
 * @param {string} cwd
 * @param {string} command
 * @param {{ spawnFn?: typeof spawnSync; dryRun?: boolean }} [opts]
 */
export function runBuildCommand(cwd, command, opts = {}) {
  if (opts.dryRun) return { ok: true, skipped: true };
  const spawnFn = opts.spawnFn ?? spawnSync;
  const r = spawnFn(command, {
    cwd,
    encoding: "utf8",
    timeout: 600_000,
    shell: true,
  });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    skipped: false,
  };
}
