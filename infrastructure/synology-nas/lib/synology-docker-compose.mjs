import { ensureSynologyDocker } from "./synology-docker-ensure.mjs";
import { synologyRemoteExec } from "./synology-ssh.mjs";

const DEFAULT_COMPOSE_BASE = "/volume1/docker";

/**
 * @param {string} path
 */
export function assertSafeComposePath(path) {
  const t = path.trim();
  if (!t || t.includes("..")) {
    throw new Error(`unsafe compose path: ${JSON.stringify(path)}`);
  }
  if (!/^\/[a-zA-Z0-9_./'-]+$/.test(t)) {
    throw new Error(`compose path must be absolute and safe: ${JSON.stringify(path)}`);
  }
}

/**
 * @param {string} stackId
 */
export function composeDirFromStack(stackId, baseDir = DEFAULT_COMPOSE_BASE) {
  const slug = stackId.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").toLowerCase();
  if (!slug || slug.includes("..")) {
    throw new Error(`unsafe stack id: ${JSON.stringify(stackId)}`);
  }
  const base = baseDir.replace(/\/$/, "");
  return `${base}/${slug}`;
}

/**
 * @param {string} path
 */
function shellQuotePath(path) {
  return path.replace(/'/g, `'\\''`);
}

/**
 * @param {object} spec
 * @param {string} spec.dir
 * @param {string} [spec.composeYaml]
 * @param {string} [spec.envContent]
 * @param {boolean} [spec.pull]
 */
export function buildComposeUpScript(spec) {
  assertSafeComposePath(spec.dir);
  const dir = shellQuotePath(spec.dir);
  const lines = ["set -euo pipefail", `mkdir -p '${dir}'`];

  if (spec.composeYaml) {
    lines.push(`cat > '${dir}/docker-compose.yml' <<'HDCCOMPOSE'`, spec.composeYaml.trimEnd(), "HDCCOMPOSE");
  }

  if (spec.envContent) {
    lines.push(`cat > '${dir}/.env' <<'HDCENV'`, spec.envContent.trimEnd(), "HDCENV");
  }

  lines.push(
    `cd '${dir}'`,
    "test -f docker-compose.yml",
  );
  if (spec.pull !== false) {
    lines.push("docker compose pull");
  }
  lines.push("docker compose up -d", "docker compose ps");
  return lines.join("\n");
}

/**
 * @param {object} spec
 * @param {string} spec.dir
 * @param {boolean} [spec.pull]
 */
export function buildComposeMaintainScript(spec) {
  assertSafeComposePath(spec.dir);
  const dir = shellQuotePath(spec.dir);
  const lines = [
    "set -euo pipefail",
    `cd '${dir}'`,
    "test -f docker-compose.yml",
  ];
  if (spec.pull !== false) {
    lines.push("docker compose pull");
  }
  lines.push("docker compose up -d", "docker compose ps");
  return lines.join("\n");
}

/**
 * @param {object} spec
 * @param {string} spec.dir
 * @param {boolean} [spec.removeVolumes]
 */
export function buildComposeDownScript(spec) {
  assertSafeComposePath(spec.dir);
  const dir = shellQuotePath(spec.dir);
  const downFlag = spec.removeVolumes ? " -v" : "";
  return [
    "set -euo pipefail",
    `if test -f '${dir}/docker-compose.yml'; then`,
    `  cd '${dir}' && docker compose down${downFlag} 2>/dev/null || true`,
    "fi",
  ].join("\n");
}

/**
 * @param {object} execOpts
 * @param {object} spec
 * @param {(s: string) => void} log
 * @param {{ ensureDocker?: boolean; dryRun?: boolean }} [opts]
 */
export async function deployComposeStack(execOpts, spec, log, opts = {}) {
  const { ensureDocker: doEnsure = true, dryRun = false } = opts;
  const { target } = execOpts;

  if (doEnsure) {
    const ensured = await ensureSynologyDocker(execOpts, { log, dryRun });
    if (!ensured.ok) {
      return { ok: false, method: "docker-compose", message: ensured.message ?? "docker ensure failed" };
    }
  }

  if (dryRun) {
    log(`[${target.id}] compose: dry-run deploy to ${spec.dir}`);
    return { ok: true, method: "docker-compose", skipped: true, dir: spec.dir };
  }

  log(`[${target.id}] compose: deploy to ${spec.dir} …`);
  const script = buildComposeUpScript(spec);
  const r = synologyRemoteExec({ ...execOpts, timeoutMs: 900_000 }, script);
  if (r.status !== 0) {
    const msg = `${r.stderr || r.stdout}`.trim() || `remote exit ${r.status}`;
    return { ok: false, method: "docker-compose", message: msg, dir: spec.dir };
  }
  return {
    ok: true,
    method: "docker-compose",
    dir: spec.dir,
    output: r.stdout.trim().slice(0, 1500),
  };
}

/**
 * @param {object} execOpts
 * @param {object} spec
 * @param {(s: string) => void} log
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function maintainComposeStack(execOpts, spec, log, opts = {}) {
  const { dryRun = false } = opts;
  const { target } = execOpts;

  if (dryRun) {
    log(`[${target.id}] compose: dry-run maintain ${spec.dir}`);
    return { ok: true, method: "docker-compose", skipped: true, dir: spec.dir };
  }

  log(`[${target.id}] compose: maintain ${spec.dir} …`);
  const script = buildComposeMaintainScript(spec);
  const r = synologyRemoteExec({ ...execOpts, timeoutMs: 900_000 }, script);
  if (r.status !== 0) {
    const msg = `${r.stderr || r.stdout}`.trim() || `remote exit ${r.status}`;
    return { ok: false, method: "docker-compose", message: msg, dir: spec.dir };
  }
  return {
    ok: true,
    method: "docker-compose",
    dir: spec.dir,
    output: r.stdout.trim().slice(0, 1500),
  };
}

/**
 * @param {object} execOpts
 * @param {object} spec
 * @param {(s: string) => void} log
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function teardownComposeStack(execOpts, spec, log, opts = {}) {
  const { dryRun = false } = opts;
  const { target } = execOpts;

  if (dryRun) {
    log(`[${target.id}] compose: dry-run teardown ${spec.dir}`);
    return { ok: true, method: "docker-compose", skipped: true, dir: spec.dir };
  }

  log(`[${target.id}] compose: teardown ${spec.dir} …`);
  const script = buildComposeDownScript(spec);
  const r = synologyRemoteExec(execOpts, script);
  if (r.status !== 0) {
    const msg = `${r.stderr || r.stdout}`.trim() || `remote exit ${r.status}`;
    return { ok: false, method: "docker-compose", message: msg, dir: spec.dir };
  }
  return { ok: true, method: "docker-compose", dir: spec.dir };
}
