import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolvePveSshForHost } from "./llama-cpp-install.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} server
 */
export async function queryLlamaCppInCt(user, pveHost, vmid, server) {
  const port =
    isObject(server) && typeof server.port === "number" && Number.isFinite(server.port)
      ? server.port
      : Number(isObject(server) ? server.port : NaN) || 8080;

  const active = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active llama-server 2>/dev/null || echo inactive",
    { capture: true },
  );
  const version = pctExec(user, pveHost, vmid, "cat /opt/llama_cpp_version.txt 2>/dev/null || true", {
    capture: true,
  });
  const binary = pctExec(
    user,
    pveHost,
    vmid,
    "test -x /usr/local/bin/llama-server && echo yes || echo no",
    { capture: true },
  );

  let health = null;
  let healthError = null;
  if (active.stdout.trim() === "active") {
    const healthCmd = `curl -sf --max-time 5 http://127.0.0.1:${port}/health -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      health = "ok";
    } else {
      health = "fail";
      healthError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  return {
    vmid,
    systemd_active: active.stdout.trim(),
    release: version.stdout.trim() || null,
    binary_installed: binary.stdout.trim() === "yes",
    health,
    health_error: healthError,
    port,
  };
}

/**
 * @param {string} sshUser
 * @param {string} sshHost
 * @param {Record<string, unknown>} server
 */
export async function queryLlamaCppViaSsh(sshUser, sshHost, server) {
  const port =
    isObject(server) && typeof server.port === "number" && Number.isFinite(server.port)
      ? server.port
      : Number(isObject(server) ? server.port : NaN) || 8080;

  const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });

  const active = exec.run("systemctl is-active llama-server 2>/dev/null || echo inactive", {
    capture: true,
  });
  const version = exec.run("cat /opt/llama_cpp_version.txt 2>/dev/null || true", { capture: true });
  const binary = exec.run("test -x /usr/local/bin/llama-server && echo yes || echo no", {
    capture: true,
  });
  const nvidia = exec.run("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true", {
    capture: true,
  });

  let health = null;
  let healthError = null;
  if (active.stdout.trim() === "active") {
    const healthCmd = `curl -sf --max-time 5 http://127.0.0.1:${port}/health -o /dev/null && echo ok || echo fail`;
    const h = exec.run(healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      health = "ok";
    } else {
      health = "fail";
      healthError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  const gpuName = nvidia.stdout.trim() || null;

  return {
    ssh_host: sshHost,
    systemd_active: active.stdout.trim(),
    release: version.stdout.trim() || null,
    binary_installed: binary.stdout.trim() === "yes",
    gpu: gpuName,
    health,
    health_error: healthError,
    port,
  };
}
