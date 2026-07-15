import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { appDir, listenPort, resolveAccessUrl } from "./postiz-render.mjs";
import { readCtPrimaryIp, readInstalledVersion } from "./postiz-install.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} postiz
 * @param {Record<string, unknown>} install
 */
export async function queryPostizInCt(user, pveHost, vmid, postiz, install) {
  const dir = appDir(isObject(install) ? install : {});
  const port = listenPort(isObject(postiz) ? postiz : {});

  const services = [
    "postiz-temporal",
    "postiz-backend",
    "postiz-frontend",
    "postiz-orchestrator",
    "nginx",
    "redis-server",
    "postgresql",
  ];
  /** @type {Record<string, string>} */
  const systemd = {};
  for (const unit of services) {
    const r = pctExec(user, pveHost, vmid, `systemctl is-active ${unit} 2>/dev/null || echo inactive`, {
      capture: true,
    });
    systemd[unit] = r.stdout.trim() || "unknown";
  }

  const nginxTest = pctExec(user, pveHost, vmid, "nginx -t 2>&1", { capture: true });
  const installed = readInstalledVersion(user, pveHost, vmid);
  const ctIp = readCtPrimaryIp(user, pveHost, vmid);
  const accessUrl = resolveAccessUrl(postiz, ctIp);

  let httpOk = null;
  let httpError = null;
  if (systemd.nginx === "active") {
    const probeUrl = accessUrl ?? `http://127.0.0.1:${port}`;
    const h = pctExec(
      user,
      pveHost,
      vmid,
      `curl -sf --max-time 8 ${JSON.stringify(probeUrl)} -o /dev/null && echo ok || echo fail`,
      { capture: true },
    );
    if (h.status === 0 && h.stdout.trim() === "ok") {
      httpOk = true;
    } else {
      httpOk = false;
      httpError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  const appPresent = pctExec(user, pveHost, vmid, `test -d ${JSON.stringify(dir)} && echo yes`, {
    capture: true,
  });

  return {
    vmid,
    app_dir: dir,
    app_present: appPresent.stdout.trim() === "yes",
    installed_version: installed,
    ct_ip: ctIp,
    access_url: accessUrl,
    listen_port: port,
    systemd,
    nginx_config_ok: nginxTest.status === 0,
    nginx_config_detail: nginxTest.stderr.trim() || nginxTest.stdout.trim() || null,
    http_ok: httpOk,
    http_error: httpError,
  };
}
