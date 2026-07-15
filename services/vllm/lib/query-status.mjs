import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { composeDir, hostPort, parsePublicUrl } from "./vllm-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} sshUser
 * @param {string} sshHost
 * @param {Record<string, unknown>} vllm
 * @param {Record<string, unknown>} install
 */
export async function queryVllmViaSsh(sshUser, sshHost, vllm, install) {
  const cfg = isObject(vllm) ? vllm : {};
  const installCfg = isObject(install) ? install : {};
  const port = hostPort(cfg);
  const dir = composeDir(installCfg);
  let publicUrl = null;
  try {
    const parsed = parsePublicUrl(cfg);
    publicUrl = parsed ? parsed.origin.replace(/\/+$/, "") : null;
  } catch {
    publicUrl = null;
  }

  const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });

  const docker = exec.run("systemctl is-active docker 2>/dev/null || echo inactive", {
    capture: true,
  });
  const composePs = exec.run(
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );
  const nvidia = exec.run(
    "nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true",
    { capture: true },
  );

  let healthOk = null;
  let healthError = null;
  let modelsOk = null;
  let modelsError = null;
  let modelsPreview = null;

  if (docker.stdout.trim() === "active") {
    const healthCmd = `curl -sf --max-time 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/health || echo fail`;
    const h = exec.run(healthCmd, { capture: true });
    const code = h.stdout.trim();
    if (h.status === 0 && /^\d+$/.test(code) && Number(code) >= 200 && Number(code) < 500) {
      healthOk = true;
    } else {
      healthOk = false;
      healthError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }

    const modelsCmd = `curl -sf --max-time 15 http://127.0.0.1:${port}/v1/models 2>/dev/null | head -c 2000 || echo fail`;
    const m = exec.run(modelsCmd, { capture: true });
    const body = m.stdout.trim();
    if (m.status === 0 && body && body !== "fail" && body.includes("{")) {
      modelsOk = true;
      modelsPreview = body.slice(0, 500);
    } else {
      modelsOk = false;
      modelsError = m.stderr.trim() || body || `exit ${m.status}`;
    }
  }

  return {
    ssh_host: sshHost,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    gpu: nvidia.stdout.trim() || null,
    public_url: publicUrl,
    health_ok: healthOk,
    health_error: healthError,
    models_ok: modelsOk,
    models_error: modelsError,
    models_preview: modelsPreview,
    host_port: port,
    url: publicUrl || `http://${sshHost}:${port}`,
    upstream_url: `http://${sshHost}:${port}`,
  };
}
