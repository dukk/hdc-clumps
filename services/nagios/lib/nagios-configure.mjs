import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { ensureNagiosApacheInCt, NAGIOS_GENERATED_CFG, upgradeNagiosInCt } from "./nagios-install.mjs";

const CFG_DELIM = "HDCNAGIOSCFG";

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} nagiosCfg
 */
export function configureNagiosInCt(user, pveHost, vmid, nagiosCfg) {
  errout.write(`[hdc] nagios configure: pushing generated config to CT ${vmid} …\n`);

  if (nagiosCfg.includes(`\n${CFG_DELIM}\n`)) {
    return { ok: false, message: `config contains reserved delimiter ${CFG_DELIM}` };
  }

  const script = [
    "set -euo pipefail",
    "mkdir -p /etc/nagios4/conf.d",
    `cat > ${NAGIOS_GENERATED_CFG} <<'${CFG_DELIM}'`,
    nagiosCfg.replace(/\r?\n$/, ""),
    CFG_DELIM,
    "/usr/sbin/nagios4 -v /etc/nagios4/nagios.cfg",
    "systemctl reload nagios4",
    "sleep 1",
    "systemctl is-active --quiet nagios4",
  ].join("\n");

  const r = pctExec(user, pveHost, vmid, script);
  if (r.status !== 0) {
    return {
      ok: false,
      message: `configure failed (exit ${r.status})`,
      stderr: r.stderr?.slice(0, 500),
    };
  }
  errout.write(`[hdc] nagios configure: completed on CT ${vmid}.\n`);
  return { ok: true, message: "configured", config_path: NAGIOS_GENERATED_CFG };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} nagiosCfg
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainNagiosInCt(user, pveHost, vmid, nagiosCfg, opts = {}) {
  /** @type {Record<string, unknown>} */
  const out = { ok: true };

  const apache = await ensureNagiosApacheInCt(user, pveHost, vmid);
  out.apache = apache;
  if (!apache.ok) {
    return { ok: false, message: apache.message, ...out };
  }

  if (!opts.skipUpgrade) {
    const upgrade = await upgradeNagiosInCt(user, pveHost, vmid);
    out.upgrade = upgrade;
    if (!upgrade.ok) {
      return { ok: false, message: upgrade.message, ...out };
    }
  }

  const configure = configureNagiosInCt(user, pveHost, vmid, nagiosCfg);
  out.configure = configure;
  return { ok: configure.ok, message: configure.message, ...out };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function queryNagiosStatusInCt(user, pveHost, vmid) {
  const script = [
    "set -euo pipefail",
    "systemctl is-active nagios4 2>/dev/null || echo inactive",
    "systemctl is-enabled nagios4 2>/dev/null || echo unknown",
    `/usr/sbin/nagios4 -V 2>/dev/null | head -n 1 || echo version_unknown`,
    `[ -f ${NAGIOS_GENERATED_CFG} ] && echo config_ok || echo config_missing`,
    `grep -c '^define host' ${NAGIOS_GENERATED_CFG} 2>/dev/null || echo 0`,
    "systemctl is-active apache2 2>/dev/null || echo inactive",
    "apache2ctl -M 2>/dev/null | grep -q cgi_module && echo cgi_ok || echo cgi_missing",
  ].join("; ");

  const r = pctExec(user, pveHost, vmid, script, { capture: true });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `query failed (exit ${r.status})`,
      stderr: r.stderr?.slice(0, 300),
    };
  }

  const lines = r.stdout.trim().split(/\n/).map((l) => l.trim());
  const serviceActive = lines[0] === "active";
  const hostCount = Number(lines[4]) || 0;
  const apacheActive = lines[5] === "active";
  const cgiModule = lines[6] === "cgi_ok";

  return {
    ok: serviceActive && lines[3] === "config_ok" && apacheActive && cgiModule,
    service_active: serviceActive,
    service_enabled: lines[1] === "enabled",
    version_line: lines[2] || null,
    config: lines[3],
    host_count_in_cfg: hostCount,
    apache_active: apacheActive,
    cgi_module: cgiModule,
    raw: lines,
  };
}
