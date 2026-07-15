import { createGuestSshExec } from "hdc/package/guest-ssh-exec.mjs";
import { trivyScanTargets } from "./deployments.mjs";

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {object} target
 * @param {string[]} target.paths
 * @param {string[]} target.docker_compose_dirs
 */
function buildRemoteScanScript(target) {
  const lines = [
    "set -euo pipefail",
    "if ! command -v trivy >/dev/null 2>&1; then",
    "  export DEBIAN_FRONTEND=noninteractive",
    "  apt-get update -qq",
    "  apt-get install -y -qq curl ca-certificates tar",
    "  tmp=$(mktemp -d)",
    "  ver='0.56.2'",
    "  curl -fsSL https://github.com/aquasecurity/trivy/releases/download/v${ver}/trivy_${ver}_Linux-64bit.tar.gz -o \"$tmp/trivy.tar.gz\"",
    "  tar -xzf \"$tmp/trivy.tar.gz\" -C \"$tmp\" trivy",
    "  install -m 0755 \"$tmp/trivy\" /usr/local/bin/trivy",
    "  rm -rf \"$tmp\"",
    "fi",
  ];
  for (const p of target.paths) {
    lines.push(`trivy fs --quiet --severity HIGH,CRITICAL --format table ${shellQuote(p)} || true`);
  }
  for (const dir of target.docker_compose_dirs) {
    lines.push(
      `if test -f ${shellQuote(`${dir}/docker-compose.yml`)}; then`,
      `  cd ${shellQuote(dir)}`,
      "  imgs=$(docker compose config --images 2>/dev/null || true)",
      "  for i in $imgs; do trivy image --quiet --severity HIGH,CRITICAL \"$i\" || true; done",
      "fi",
    );
  }
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} trivy
 * @param {(line: string) => void} [log]
 */
export async function runTrivyScans(trivy, log = () => {}) {
  const targets = trivyScanTargets(trivy);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const target of targets) {
    const exec = createGuestSshExec({
      host: target.host,
      preferredUser: target.ssh_user ?? undefined,
      log,
    });
    const r = exec.run(buildRemoteScanScript(target), { capture: true });
    results.push({
      ok: r.status === 0,
      id: target.id ?? target.host,
      host: target.host,
      ssh_user: exec.effectiveUser,
      fallback_used: exec.fallback_used,
      paths: target.paths,
      docker_compose_dirs: target.docker_compose_dirs,
      message: r.status === 0 ? "scan complete" : `scan failed (exit ${r.status})`,
      output: (r.stdout || r.stderr || "").slice(0, 12000),
    });
  }
  return { ok: results.every((r) => r.ok), count: results.length, results };
}
