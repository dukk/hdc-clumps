import { synologyRemoteExec } from "./synology-ssh.mjs";

/** Read-only probe (query) — no install/start. */
export const DOCKER_PROBE_SCRIPT = `
set -uo pipefail
DOCKER_PKG=""
DOCKER_STATUS=""
/usr/syno/bin/synopkg status ContainerManager >/dev/null 2>&1
code=$?
if [ "$code" = "0" ] || [ "$code" = "17" ]; then
  DOCKER_PKG=ContainerManager
  DOCKER_STATUS=$code
fi
if [ -z "$DOCKER_PKG" ]; then
  /usr/syno/bin/synopkg status Docker >/dev/null 2>&1
  code=$?
  if [ "$code" = "0" ] || [ "$code" = "3" ]; then
    DOCKER_PKG=Docker
    DOCKER_STATUS=$code
  elif [ "$code" = "4" ]; then
    DOCKER_PKG=Docker
    DOCKER_STATUS=not_installed
  fi
fi
echo "===DOCKER_PKG==="
echo "$DOCKER_PKG"
echo "===DOCKER_STATUS==="
echo "$DOCKER_STATUS"
echo "===DOCKER_CLI==="
command -v docker 2>/dev/null || true
echo "===DOCKER_VERSION==="
docker version --format '{{.Server.Version}}' 2>/dev/null || true
echo "===COMPOSE_VERSION==="
docker compose version --short 2>/dev/null || true
echo "===DOCKER_PS==="
docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
`.trim();

/** Ensure Container Manager / Docker package and docker CLI (maintain). */
export const DOCKER_ENSURE_SCRIPT = `
set -uo pipefail
DOCKER_PKG=""
DOCKER_STATUS=""
ACTION=none
/usr/syno/bin/synopkg status ContainerManager >/dev/null 2>&1
code=$?
if [ "$code" = "0" ] || [ "$code" = "17" ] || [ "$code" = "255" ]; then
  DOCKER_PKG=ContainerManager
  DOCKER_STATUS=$code
fi
if [ -z "$DOCKER_PKG" ]; then
  /usr/syno/bin/synopkg status Docker >/dev/null 2>&1
  code=$?
  if [ "$code" = "0" ] || [ "$code" = "3" ] || [ "$code" = "4" ]; then
    DOCKER_PKG=Docker
    DOCKER_STATUS=$code
  fi
fi
if [ -z "$DOCKER_PKG" ]; then
  echo "===RESULT==="
  echo "error:no_docker_package_detected"
  exit 1
fi
if [ "$DOCKER_STATUS" = "255" ] || [ "$DOCKER_STATUS" = "4" ]; then
  echo "===ACTION==="
  echo "install"
  /usr/syno/bin/synopkg install "$DOCKER_PKG" 2>&1 || true
  /usr/syno/bin/synopkg status "$DOCKER_PKG" >/dev/null 2>&1
  DOCKER_STATUS=$?
  ACTION=installed
fi
if [ "$DOCKER_STATUS" = "17" ] || [ "$DOCKER_STATUS" = "3" ]; then
  echo "===ACTION==="
  echo "start"
  /usr/syno/bin/synopkg start "$DOCKER_PKG" 2>&1 || true
  ACTION=started
  DOCKER_STATUS=0
fi
echo "===DOCKER_PKG==="
echo "$DOCKER_PKG"
echo "===DOCKER_STATUS==="
echo "$DOCKER_STATUS"
echo "===ACTION==="
echo "$ACTION"
echo "===DOCKER_CLI==="
command -v docker 2>/dev/null || true
if ! command -v docker >/dev/null 2>&1; then
  echo "===RESULT==="
  echo "error:docker_cli_missing"
  exit 1
fi
docker info >/dev/null 2>&1 || { echo "===RESULT==="; echo "error:docker_info_failed"; exit 1; }
echo "===DOCKER_VERSION==="
docker version --format '{{.Server.Version}}' 2>/dev/null || true
echo "===COMPOSE_VERSION==="
docker compose version --short 2>/dev/null || true
echo "===RESULT==="
echo "ok"
`.trim();

/**
 * @returns {string}
 */
export function buildDockerEnsureScript() {
  return DOCKER_ENSURE_SCRIPT;
}

/**
 * @returns {string}
 */
export function buildDockerProbeScript() {
  return DOCKER_PROBE_SCRIPT;
}

/**
 * @param {string} raw
 * @returns {{
 *   package: string | null;
 *   status: string | null;
 *   running: boolean;
 *   dockerCli: string | null;
 *   dockerVersion: string | null;
 *   composeVersion: string | null;
 *   action: string | null;
 *   result: string | null;
 *   composeAvailable: boolean;
 * }}
 */
export function parseDockerSectionOutput(raw) {
  /** @type {Record<string, string>} */
  const sections = {};
  let current = "";
  for (const line of raw.split(/\r?\n/)) {
    if (line === "===DOCKER_PKG===") {
      current = "pkg";
      continue;
    }
    if (line === "===DOCKER_STATUS===") {
      current = "status";
      continue;
    }
    if (line === "===DOCKER_CLI===") {
      current = "cli";
      continue;
    }
    if (line === "===DOCKER_VERSION===") {
      current = "version";
      continue;
    }
    if (line === "===COMPOSE_VERSION===") {
      current = "compose";
      continue;
    }
    if (line === "===DOCKER_PS===") {
      current = "ps";
      continue;
    }
    if (line === "===ACTION===") {
      current = "action";
      continue;
    }
    if (line === "===RESULT===") {
      current = "result";
      continue;
    }
    if (current) sections[current] = (sections[current] ?? "") + `${line}\n`;
  }

  const pkg = (sections.pkg ?? "").trim() || null;
  const statusRaw = (sections.status ?? "").trim();
  const status = statusRaw || null;
  const running =
    status === "0" ||
    (pkg === "ContainerManager" && status === "0") ||
    (pkg === "Docker" && status === "0");
  const dockerCli = (sections.cli ?? "").trim() || null;
  const dockerVersion = (sections.version ?? "").trim() || null;
  const composeVersion = (sections.compose ?? "").trim() || null;
  const action = (sections.action ?? "").trim() || null;
  const result = (sections.result ?? "").trim() || null;
  /** @type {{ id: string; name: string; image: string; status: string; ports: string }[]} */
  const containers = [];
  for (const line of (sections.ps ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split("\t");
    if (parts.length < 4) continue;
    containers.push({
      id: parts[0] ?? "",
      name: parts[1] ?? "",
      image: parts[2] ?? "",
      status: parts[3] ?? "",
      ports: parts[4] ?? "",
    });
  }

  return {
    package: pkg,
    status,
    running: running || Boolean(dockerCli && dockerVersion),
    dockerCli,
    dockerVersion,
    composeVersion,
    action,
    result,
    composeAvailable: Boolean(composeVersion),
    containers,
  };
}

/**
 * @param {object} execOpts
 * @param {{ log?: (s: string) => void; dryRun?: boolean }} [opts]
 */
export async function ensureSynologyDocker(execOpts, opts = {}) {
  const { log = () => {}, dryRun = false } = opts;
  const { target } = execOpts;

  if (dryRun) {
    log(`[${target.id}] docker: dry-run — would ensure Container Manager / Docker`);
    return {
      ok: true,
      skipped: true,
      installed: false,
      started: false,
      package: null,
      dockerVersion: null,
      composeAvailable: false,
      message: "dry-run",
    };
  }

  log(`[${target.id}] docker: ensuring Container Manager / Docker …`);
  const r = synologyRemoteExec(
    { ...execOpts, timeoutMs: 900_000 },
    buildDockerEnsureScript(),
  );
  const combined = `${r.stdout}\n${r.stderr}`;
  const parsed = parseDockerSectionOutput(combined);

  if (r.status !== 0 || parsed.result?.startsWith("error:")) {
    const err =
      (parsed.result?.replace(/^error:/, "") ?? `${r.stderr || r.stdout}`.trim()) ||
      `remote exit ${r.status}`;
    return {
      ok: false,
      skipped: false,
      installed: parsed.action === "installed",
      started: parsed.action === "started",
      package: parsed.package,
      dockerVersion: parsed.dockerVersion,
      composeAvailable: parsed.composeAvailable,
      message: `docker ensure failed: ${err}`,
      raw: combined.slice(0, 2000),
    };
  }

  if (!parsed.composeAvailable) {
    log(`[${target.id}] docker: WARN docker compose plugin not detected`);
  }

  log(
    `[${target.id}] docker: OK (${parsed.package ?? "unknown"}${parsed.dockerVersion ? ` ${parsed.dockerVersion}` : ""})`,
  );

  return {
    ok: true,
    skipped: false,
    installed: parsed.action === "installed",
    started: parsed.action === "started",
    package: parsed.package,
    dockerVersion: parsed.dockerVersion,
    composeAvailable: parsed.composeAvailable,
    composeVersion: parsed.composeVersion,
    message: null,
    raw: combined.slice(0, 1500),
  };
}

/**
 * @param {object} execOpts
 */
export function probeSynologyDocker(execOpts) {
  const r = synologyRemoteExec(execOpts, buildDockerProbeScript());
  const combined = `${r.stdout}\n${r.stderr}`;
  const parsed = parseDockerSectionOutput(combined);
  if (r.status !== 0) {
    return {
      ok: false,
      message: `${r.stderr || r.stdout}`.trim() || `remote exit ${r.status}`,
      docker: null,
    };
  }
  return {
    ok: true,
    message: null,
    docker: {
      package: parsed.package,
      status: parsed.status,
      running: parsed.running,
      docker_cli: parsed.dockerCli,
      version: parsed.dockerVersion,
      compose: parsed.composeAvailable,
      compose_version: parsed.composeVersion,
    },
  };
}
