import { pctExec, sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { composeDir, hostPort, normalizeExternalUrl } from "./keycloak-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} keycloak
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} [lxc]
 */
export async function queryKeycloakInCt(user, pveHost, vmid, keycloak, install, lxc = {}) {
  const cfg = isObject(keycloak) ? keycloak : {};
  const dir = composeDir(isObject(install) ? install : {});
  const port = hostPort(cfg);
  let externalUrl = null;
  try {
    externalUrl = normalizeExternalUrl(cfg);
  } catch {
    externalUrl = null;
  }

  const docker = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active docker 2>/dev/null || echo inactive",
    { capture: true },
  );
  const composePs = pctExec(
    user,
    pveHost,
    vmid,
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );
  const composeLogs = pctExec(
    user,
    pveHost,
    vmid,
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose logs --tail 20 2>/dev/null | tail -c 4000 || true`,
    { capture: true },
  );
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  const health = pctExec(
    user,
    pveHost,
    vmid,
    `curl -sf --max-time 8 http://127.0.0.1:9000/health/ready -o /dev/null && echo ok || (curl -sf --max-time 8 http://127.0.0.1:${port}/health/ready -o /dev/null && echo ok || echo fail)`,
    { capture: true },
  );

  const featuresCfg = sshRemote(user, pveHost, `pct config ${vmid} 2>/dev/null | grep -E '^(features|lxc.cgroup|lxc.apparmor)' || true`, {
    capture: true,
  });
  const apparmorProfile = sshRemote(
    user,
    pveHost,
    `grep -E 'lxc.apparmor.profile' /etc/pve/lxc/${vmid}.conf 2>/dev/null || true`,
    { capture: true },
  );

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    compose_logs_tail: (composeLogs.stdout || "").trim() || null,
    ct_ip: ctIp,
    external_url: externalUrl,
    health_ok: health.stdout.trim() === "ok",
    host_port: port,
    upstream_url: ctIp ? `http://${ctIp}:${port}` : null,
    lxc: {
      configured_features: typeof lxc.features === "string" ? lxc.features : null,
      unprivileged: lxc.unprivileged,
      live_config_excerpt: (featuresCfg.stdout || "").trim() || null,
      apparmor_profile_line: (apparmorProfile.stdout || "").trim() || null,
    },
  };
}
