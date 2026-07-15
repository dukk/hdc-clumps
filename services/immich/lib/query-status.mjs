import { composeDir } from "./immich-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} immich
 * @param {Record<string, unknown>} install
 */
export async function queryImmichOnHost(exec, immich, install) {
  const port =
    isObject(immich) && typeof immich.port === "number" && Number.isFinite(immich.port)
      ? immich.port
      : Number(isObject(immich) ? immich.port : NaN) || 2283;
  const dir = composeDir(isObject(install) ? install : {});

  const docker = exec.run("systemctl is-active docker 2>/dev/null || echo inactive", {
    capture: true,
  });
  const composePs = exec.run(
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );

  let httpOk = null;
  let httpError = null;
  if (docker.stdout.trim() === "active") {
    const healthCmd = `curl -sf --max-time 10 http://127.0.0.1:${port}/api/server/ping -o /dev/null && echo ok || echo fail`;
    const h = exec.run(healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      httpOk = true;
    } else {
      httpOk = false;
      httpError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  const hostMatch = exec.label.match(/@([^:]+)$/);
  const host = hostMatch?.[1] ?? null;

  return {
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    host,
    http_ok: httpOk,
    http_error: httpError,
    port,
    ui_url: host ? `http://${host}:${port}` : null,
  };
}
