import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { gatewayPort, resolveDashboardUrl } from "./openclaw-render.mjs";
import { resolveLinuxUser } from "./openclaw-install-user.mjs";

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {Record<string, unknown>} openclaw
 * @param {Record<string, unknown>} install
 * @param {string | null} guestIp
 */
export async function queryOpenclawLive(exec, openclaw, install, guestIp) {
  const port = gatewayPort(openclaw);
  const linuxUser = resolveLinuxUser(install);
  const urls = resolveDashboardUrl(openclaw, guestIp);

  const script = [
    "set -euo pipefail",
    `LINUX_USER=${JSON.stringify(linuxUser)}`,
    `OC_HOME=/home/${linuxUser}`,
    'runuser -u "$LINUX_USER" -- env HOME="$OC_HOME" bash -lc \'export PATH="$(npm prefix -g)/bin:$PATH"; openclaw --version 2>/dev/null || true\'',
    'runuser -u "$LINUX_USER" -- env HOME="$OC_HOME" bash -lc \'systemctl --user is-active openclaw-gateway.service 2>/dev/null || echo inactive\'',
    `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/readyz 2>/dev/null || curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/health 2>/dev/null || echo 000`,
    "command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && echo docker_ok || echo docker_missing",
  ].join("\n");

  const r = exec.run(script, { capture: true });
  const lines = `${r.stdout}`.trim().split("\n").filter(Boolean);
  const versionLine = lines.find((l) => l.includes("openclaw") || /^\d/.test(l)) ?? "";
  const systemdActive = lines.find((l) => /^(active|inactive|failed|unknown)$/.test(l.trim())) ?? "unknown";
  const httpCode = lines.find((l) => /^\d{3}$/.test(l.trim())) ?? "000";
  const docker = lines.includes("docker_ok") ? "ok" : lines.includes("docker_missing") ? "missing" : "unknown";

  return {
    ok: r.status === 0 && (httpCode === "200" || httpCode === "204"),
    openclaw_version: versionLine.trim() || null,
    systemd_active: systemdActive.trim(),
    gateway_http: httpCode.trim(),
    docker,
    gateway_url: urls.gateway_url,
    access_note: urls.access_note,
  };
}
