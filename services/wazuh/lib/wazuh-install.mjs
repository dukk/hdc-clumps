import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { buildWazuhManagerAlertsPatchBash } from "hdc/package/wazuh-manager-alerts.mjs";
import {
  buildOfficialStackInstallScript,
  composeDir,
  renderWazuhEnv,
  resolveDashboardUrl,
  wazuhAuthdPasswordEnsureBash,
  wazuhDockerRelease,
  wazuhDashboardApiConfigSyncBash,
  wazuhStackApiCredentialsPatchBash,
  wazuhIndexerPasswordResyncBash,
  wazuhStackDir,
} from "./wazuh-render.mjs";
import { buildWazuhNotificationsSyncBash } from "./wazuh-notifications.mjs";
import { buildWazuhDashboardMonitorsSyncBash } from "./wazuh-dashboard-monitors.mjs";
import { buildWazuhAlertIgnoreSyncBash, resolveWazuhAlertIgnore } from "./wazuh-alert-ignore.mjs";
import { wazuhDashboardPort } from "./deployments.mjs";

export { resolvePveSshForHost };

/**
 * @typedef {{ run: (script: string) => { status: number; stdout: string; stderr: string }; label?: string }} GuestExec
 */

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {Record<string, unknown>} wazuh
 * @param {Record<string, unknown>} install
 * @param {string} apiPassword
 * @param {string} agentPassword
 */
/**
 * @param {import("./wazuh-mail-config.mjs").WazuhMailSettings | null} [mailSettings]
 * @param {{ skipMail?: boolean; skipAlertIgnore?: boolean; alertIgnore?: import("./wazuh-alert-ignore.mjs").WazuhAlertIgnoreSettings | null }} [opts]
 */
export function buildInstallScript(wazuh, install, apiPassword, agentPassword, mailSettings = null, opts = {}) {
  const release = wazuhDockerRelease(wazuh);
  const dashboardPort = wazuhDashboardPort(wazuh);
  const root = composeDir(install).replace(/'/g, `'\\''`);
  const stack = wazuhStackDir(install).replace(/'/g, `'\\''`);
  const agentPw = String(agentPassword ?? "").replace(/'/g, `'\\''`);
  const alertIgnore =
    opts.alertIgnore !== undefined ? opts.alertIgnore : resolveWazuhAlertIgnore(/** @type {Record<string, unknown>} */ (wazuh));
  let script = buildOfficialStackInstallScript(release, apiPassword, agentPassword, dashboardPort).replace(
    `export WAZUH_ROOT='${composeDir({}).replace(/'/g, `'\\''`)}'`,
    `export WAZUH_ROOT='${root}'`,
  );
  if (mailSettings && !opts.skipMail) {
    script = [script, buildWazuhManagerAlertsPatchBash(mailSettings)].join("\n");
    if (mailSettings.notifications.enabled) {
      script = [script, buildWazuhNotificationsSyncBash(mailSettings)].join("\n");
    }
  }
  const envContent = renderWazuhEnv(wazuh, apiPassword, agentPassword);
  const lines = [
    script,
    `cat > '${root}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
  ];
  if (agentPw) {
    lines.push(
      `export STACK='${stack}'`,
      `export WAZUH_AGENT_PASSWORD='${agentPw}'`,
      wazuhAuthdPasswordEnsureBash(),
    );
  } else {
    lines.push(`export STACK='${stack}'`);
  }
  if (!opts.skipAlertIgnore && alertIgnore?.srcips?.length) {
    lines.push(buildWazuhAlertIgnoreSyncBash(alertIgnore));
  }
  return lines.join("\n");
}

/**
 * @param {string} composeDirPath
 * @param {string} envContent
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
/**
 * @param {import("./wazuh-mail-config.mjs").WazuhMailSettings | null} [mailSettings]
 * @param {{ skipUpgrade?: boolean; skipMail?: boolean; skipAlertIgnore?: boolean; setupDashboardMonitors?: boolean; release?: string; alertIgnore?: import("./wazuh-alert-ignore.mjs").WazuhAlertIgnoreSettings | null; agentPassword?: string }} [opts]
 */
export function buildMaintainScript(install, envContent, apiPassword, mailSettings = null, opts = {}) {
  const stack = wazuhStackDir(install).replace(/'/g, `'\\''`);
  const root = composeDir(install).replace(/'/g, `'\\''`);
  const apiPw = apiPassword.replace(/'/g, `'\\''`);
  const agentPw = String(opts.agentPassword ?? "").replace(/'/g, `'\\''`);
  const release = (opts.release ?? "").replace(/'/g, `'\\''`);
  const alertIgnore = opts.alertIgnore ?? null;
  const lines = [
    "set -euo pipefail",
    `mkdir -p '${root}'`,
    `test -f '${stack}/docker-compose.yml'`,
    `cat > '${root}/.env' <<'HDCENV'`,
    envContent.trimEnd(),
    "HDCENV",
    `cd '${stack}'`,
    `export STACK='${stack}'`,
    `export WAZUH_API_PASSWORD='${apiPw}'`,
    `export WAZUH_AGENT_PASSWORD='${agentPw}'`,
  ];
  if (release) lines.push(`export WAZUH_RELEASE='${release}'`);
  lines.push(wazuhStackApiCredentialsPatchBash());
  if (!opts.skipUpgrade) lines.push("docker compose pull");
  lines.push("docker compose up -d", wazuhDashboardApiConfigSyncBash());
  if (mailSettings && !opts.skipMail) {
    lines.push(wazuhIndexerPasswordResyncBash());
  }
  lines.push(
    'for i in $(seq 1 30); do curl -sk -u "admin:$WAZUH_API_PASSWORD" https://127.0.0.1:9200/ >/dev/null 2>&1 && break; sleep 5; done',
  );
  if (agentPw) {
    lines.push(wazuhAuthdPasswordEnsureBash());
  }
  if (mailSettings && !opts.skipMail) {
    lines.push(buildWazuhManagerAlertsPatchBash(mailSettings));
    if (mailSettings.notifications.enabled) {
      lines.push(buildWazuhNotificationsSyncBash(mailSettings));
      if (opts.setupDashboardMonitors) {
        lines.push(buildWazuhDashboardMonitorsSyncBash(mailSettings));
      }
    }
  }
  if (!opts.skipAlertIgnore && alertIgnore?.srcips?.length) {
    lines.push(buildWazuhAlertIgnoreSyncBash(alertIgnore));
  }
  lines.push("docker compose ps");
  return lines.join("\n");
}

/**
 * @param {string} composeDirPath
 */
export function buildComposeDownScript(install) {
  const stack = wazuhStackDir(install).replace(/'/g, `'\\''`);
  return [
    "set -euo pipefail",
    `if test -f '${stack}/docker-compose.yml'; then`,
    `  cd '${stack}' && docker compose down -v 2>/dev/null || true`,
    "fi",
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function readCtPrimaryIp(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  if (r.status !== 0) return null;
  const ip = r.stdout.trim().split(/\s+/)[0];
  return ip || null;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} wazuh
 * @param {Record<string, unknown>} install
 * @param {string} apiPassword
 * @param {string} agentPassword
 */
export async function installWazuhInCt(user, pveHost, vmid, wazuh, install, apiPassword, agentPassword, opts = {}) {
  errout.write(`[hdc] wazuh install: Docker Compose in CT ${vmid} ...\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, "wazuh install");
  if (!ready) {
    return { ok: false, method: "docker-compose", message: `CT ${vmid} not reachable via pct exec` };
  }
  const inner = buildInstallScript(wazuh, install, apiPassword, agentPassword, opts.mailSettings ?? null, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, method: "docker-compose", message: `install failed (exit ${r.status})` };
  }
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  return { ok: true, method: "docker-compose", message: "installed", dashboard_url: resolveDashboardUrl(wazuh, ip) };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} wazuh
 * @param {Record<string, unknown>} install
 * @param {string} apiPassword
 * @param {string} agentPassword
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainWazuhInCt(
  user,
  pveHost,
  vmid,
  wazuh,
  install,
  apiPassword,
  agentPassword,
  opts = {},
) {
  errout.write(`[hdc] wazuh maintain: refreshing stack in CT ${vmid} ...\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, "wazuh maintain");
  if (!ready) return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  const envContent = renderWazuhEnv(wazuh, apiPassword, agentPassword);
  const inner = buildMaintainScript(install, envContent, apiPassword, opts.mailSettings ?? null, {
    ...opts,
    agentPassword,
    release: wazuhDockerRelease(wazuh),
  });
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) return { ok: false, message: `maintain failed (exit ${r.status})` };
  return { ok: true, message: opts.skipUpgrade ? "restarted" : "images refreshed" };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} install
 */
export function composeDownInCt(user, pveHost, vmid, install) {
  const inner = buildComposeDownScript(install);
  pctExec(user, pveHost, vmid, inner);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} wazuh
 * @param {Record<string, unknown>} install
 */
/**
 * @param {GuestExec} exec
 * @param {Record<string, unknown>} wazuh
 * @param {Record<string, unknown>} install
 * @param {string} apiPassword
 * @param {string} agentPassword
 */
export async function installWazuhOnHost(exec, wazuh, install, apiPassword, agentPassword, opts = {}) {
  errout.write(`[hdc] wazuh install: Docker Compose via ${exec.label ?? "ssh"} …\n`);
  const inner = buildInstallScript(wazuh, install, apiPassword, agentPassword, opts.mailSettings ?? null, opts);
  const r = exec.run(inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "docker-compose",
      message: `install failed (exit ${r.status})`,
      detail: `${r.stderr}${r.stdout}`.trim() || null,
    };
  }
  const ipOut = exec.run("hostname -I | awk '{print $1}'");
  const ip = ipOut.status === 0 ? ipOut.stdout.trim().split(/\s+/)[0] || null : null;
  return { ok: true, method: "docker-compose", message: "installed", dashboard_url: resolveDashboardUrl(wazuh, ip) };
}

/**
 * @param {GuestExec} exec
 * @param {Record<string, unknown>} wazuh
 * @param {Record<string, unknown>} install
 * @param {string} apiPassword
 * @param {string} agentPassword
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainWazuhOnHost(
  exec,
  wazuh,
  install,
  apiPassword,
  agentPassword,
  opts = {},
) {
  errout.write(`[hdc] wazuh maintain: refreshing stack via ${exec.label ?? "ssh"} …\n`);
  const envContent = renderWazuhEnv(wazuh, apiPassword, agentPassword);
  const inner = buildMaintainScript(install, envContent, apiPassword, opts.mailSettings ?? null, {
    ...opts,
    agentPassword,
    release: wazuhDockerRelease(wazuh),
  });
  const r = exec.run(inner);
  if (r.status !== 0) return { ok: false, message: `maintain failed (exit ${r.status})` };
  return { ok: true, message: opts.skipUpgrade ? "restarted" : "images refreshed" };
}

/**
 * @param {GuestExec} exec
 * @param {Record<string, unknown>} install
 */
export function composeDownOnHost(exec, install) {
  const inner = buildComposeDownScript(install);
  exec.run(inner);
}

/**
 * @param {GuestExec} exec
 * @param {Record<string, unknown>} wazuh
 * @param {Record<string, unknown>} install
 * @param {number | null} [vmid]
 */
/**
 * @param {GuestExec} exec
 * @param {string} apiPassword
 */
export function queryWazuhManagerApiOnHost(exec, apiPassword) {
  const cap = { capture: true };
  const apiPw = apiPassword.replace(/'/g, `'\\''`);
  const agents = exec.run(
    `curl -sk --max-time 10 -u "wazuh-wui:${apiPw}" "https://127.0.0.1:55000/agents?pretty=false&limit=1" 2>/dev/null || echo '{}'`,
    cap,
  );
  const notifications = exec.run(
    `curl -sk --max-time 10 -u "admin:${apiPw}" "https://127.0.0.1:9200/_plugins/_notifications/configs/hdc-wazuh-alerts" 2>/dev/null || echo '{}'`,
    cap,
  );
  let agentSummary = { total: null, active: null, parse_error: null };
  try {
    const data = JSON.parse(agents.stdout.trim() || "{}");
    const inner = data.data ?? data;
    agentSummary = {
      total: typeof inner.total_affected_items === "number" ? inner.total_affected_items : null,
      active: typeof inner.active === "number" ? inner.active : null,
    };
  } catch {
    agentSummary.parse_error = "agents API response not JSON";
  }
  let notificationChannelOk = null;
  try {
    const ch = JSON.parse(notifications.stdout.trim() || "{}");
    notificationChannelOk = Boolean(ch.config_id === "hdc-wazuh-alerts" || ch.config?.config_id === "hdc-wazuh-alerts");
  } catch {
    notificationChannelOk = false;
  }
  return { agents: agentSummary, notification_channel_ok: notificationChannelOk };
}

export function queryWazuhOnHost(exec, wazuh, install, vmid = null, apiPassword = "") {
  const dir = wazuhStackDir(install);
  const dashboardPort = wazuhDashboardPort(wazuh);
  const cap = { capture: true };
  const docker = exec.run("systemctl is-active docker 2>/dev/null || echo inactive", cap);
  const composePs = exec.run(
    `test -d ${shellQuote(dir)} && cd ${shellQuote(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    cap,
  );
  const ipOut = exec.run("hostname -I | awk '{print $1}'", cap);
  const ip = ipOut.status === 0 ? ipOut.stdout.trim().split(/\s+/)[0] || null : null;
  const health = exec.run(
    `curl -skf --max-time 8 https://127.0.0.1:${dashboardPort}/ -o /dev/null && echo ok || echo fail`,
    cap,
  );
  const base = {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    guest_ip: ip,
    ct_ip: ip,
    dashboard_port: dashboardPort,
    dashboard_url: resolveDashboardUrl(wazuh, ip),
    dashboard_ok: health.stdout.trim() === "ok",
  };
  if (apiPassword) {
    return { ...base, manager_api: queryWazuhManagerApiOnHost(exec, apiPassword) };
  }
  return base;
}

export function queryWazuhInCt(user, pveHost, vmid, wazuh, install, apiPassword = "") {
  const dir = wazuhStackDir(install);
  const dashboardPort = wazuhDashboardPort(wazuh);
  const docker = pctExec(user, pveHost, vmid, "systemctl is-active docker 2>/dev/null || echo inactive", {
    capture: true,
  });
  const composePs = pctExec(
    user,
    pveHost,
    vmid,
    `test -d ${shellQuote(dir)} && cd ${shellQuote(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  const health = pctExec(
    user,
    pveHost,
    vmid,
    `curl -skf --max-time 8 https://127.0.0.1:${dashboardPort}/ -o /dev/null && echo ok || echo fail`,
    { capture: true },
  );
  const base = {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ip,
    guest_ip: ip,
    dashboard_port: dashboardPort,
    dashboard_url: resolveDashboardUrl(wazuh, ip),
    dashboard_ok: health.stdout.trim() === "ok",
  };
  if (apiPassword) {
    const cap = { capture: true };
    const apiPw = apiPassword.replace(/'/g, `'\\''`);
    const agents = pctExec(
      user,
      pveHost,
      vmid,
      `curl -sk --max-time 10 -u "wazuh-wui:${apiPw}" "https://127.0.0.1:55000/agents?pretty=false&limit=1" 2>/dev/null || echo '{}'`,
      cap,
    );
    let agentSummary = { total: null, active: null, parse_error: null };
    try {
      const data = JSON.parse(agents.stdout.trim() || "{}");
      const inner = data.data ?? data;
      agentSummary = {
        total: typeof inner.total_affected_items === "number" ? inner.total_affected_items : null,
        active: typeof inner.active === "number" ? inner.active : null,
      };
    } catch {
      agentSummary.parse_error = "agents API response not JSON";
    }
    return { ...base, manager_api: { agents: agentSummary, notification_channel_ok: null } };
  }
  return base;
}
