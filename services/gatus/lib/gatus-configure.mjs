import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import {
  gatusConfigPath,
  gatusListenPort,
  renderGatusConfigYaml,
} from "./gatus-render.mjs";
import { upgradeGatusInCt } from "./gatus-install.mjs";

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} gatus
 */
export function configureGatusInCt(user, pveHost, vmid, gatus) {
  errout.write(`[hdc] gatus configure: pushing config to CT ${vmid} …\n`);

  const configPath = gatusConfigPath(gatus);
  const yaml = renderGatusConfigYaml(gatus);
  if (yaml.includes("\nGATUSCFG\n")) {
    return { ok: false, message: "config contains reserved delimiter GATUSCFG" };
  }
  const dir = configPath.replace(/\/[^/]+$/, "");

  const script = [
    "set -euo pipefail",
    `mkdir -p ${dir}`,
    `cat > ${configPath} <<'GATUSCFG'`,
    yaml.replace(/\r?\n$/, ""),
    "GATUSCFG",
    "systemctl restart gatus",
    "sleep 2",
    "systemctl is-active --quiet gatus",
  ].join("\n");

  const r = pctExec(user, pveHost, vmid, script);
  if (r.status !== 0) {
    return {
      ok: false,
      message: `configure failed (exit ${r.status})`,
      stderr: r.stderr?.slice(0, 500),
    };
  }
  errout.write(`[hdc] gatus configure: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    message: "configured",
    config_path: configPath,
    endpoint_count: Array.isArray(gatus.endpoints) ? gatus.endpoints.length : 0,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} gatus
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainGatusInCt(user, pveHost, vmid, gatus, opts = {}) {
  /** @type {Record<string, unknown>} */
  const out = { ok: true };

  if (!opts.skipUpgrade) {
    const upgrade = await upgradeGatusInCt(user, pveHost, vmid, gatus);
    out.upgrade = upgrade;
    if (!upgrade.ok) {
      return { ok: false, message: upgrade.message, ...out };
    }
  }

  const configure = configureGatusInCt(user, pveHost, vmid, gatus);
  out.configure = configure;
  return { ok: configure.ok, message: configure.message, ...out };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} gatus
 */
export function queryGatusStatusInCt(user, pveHost, vmid, gatus) {
  const port = gatusListenPort(gatus);
  const script = [
    "set -euo pipefail",
    "systemctl is-active gatus 2>/dev/null || echo inactive",
    "systemctl is-enabled gatus 2>/dev/null || echo unknown",
    "test -x /opt/gatus/gatus && echo binary_ok || echo binary_missing",
    `[ -f ${gatusConfigPath(gatus)} ] && echo config_ok || echo config_missing`,
    `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/ 2>/dev/null || echo curl_fail`,
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
  const httpCode = lines[4] && /^\d{3}$/.test(lines[4]) ? lines[4] : null;
  const httpOk = httpCode !== null && httpCode.startsWith("2");

  return {
    ok: serviceActive && lines[2] === "binary_ok" && lines[3] === "config_ok",
    service_active: serviceActive,
    service_enabled: lines[1] === "enabled",
    binary: lines[2],
    config: lines[3],
    http_code: httpCode,
    http_ok: httpOk,
    listen_port: port,
    raw: lines,
  };
}
