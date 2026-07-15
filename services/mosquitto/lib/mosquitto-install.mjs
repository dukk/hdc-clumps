import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  HDC_ACL_PATH,
  HDC_CONF_PATH,
  renderAclFile,
  renderMosquittoConf,
  renderPasswdScript,
  tlsCertName,
  tlsEnabled,
  tlsListenerPort,
  normalizeUsers,
} from "./mosquitto-render.mjs";
import {
  createMosquittoExec,
  ensureCertbotPackages,
  obtainOrRenewCertOnGuest,
  renewCertsOnGuest,
} from "./mosquitto-tls.mjs";

export { resolvePveSshForHost };

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
 * @param {string} confContent
 * @param {string} aclContent
 * @param {string} passwdScript
 * @param {{ withPackages?: boolean }} [opts]
 */
function buildApplyScript(confContent, aclContent, passwdScript, opts = {}) {
  const confB64 = Buffer.from(confContent, "utf8").toString("base64");
  const aclB64 = Buffer.from(aclContent, "utf8").toString("base64");
  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
  ];
  if (opts.withPackages) {
    lines.push(
      "apt-get update -qq",
      "apt-get install -y -qq mosquitto mosquitto-clients certbot ca-certificates curl",
    );
  }
  lines.push(
    "install -m 0750 -d /etc/mosquitto/conf.d",
    "chown root:mosquitto /etc/mosquitto/conf.d",
    "chmod 750 /etc/mosquitto/conf.d",
    `echo ${shellQuote(confB64)} | base64 -d > ${HDC_CONF_PATH}`,
    `echo ${shellQuote(aclB64)} | base64 -d > ${HDC_ACL_PATH}`,
    "chmod 640 " + HDC_CONF_PATH + " " + HDC_ACL_PATH,
    `chown mosquitto:mosquitto ${HDC_ACL_PATH}`,
    passwdScript,
    "systemctl enable mosquitto",
    "systemctl restart mosquitto",
    "systemctl is-active mosquitto",
  );
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} mosquitto
 * @param {Map<string, string>} secrets
 */
function buildPasswdScriptWithSecrets(mosquitto, secrets) {
  /** @type {{ username: string; envVar: string }[]} */
  const userEnvVars = [];
  const exportLines = ["set -euo pipefail"];
  normalizeUsers(mosquitto).forEach((user, idx) => {
    const envVar = `HDC_MQTT_PASS_${idx}`;
    const pass = secrets.get(user.password_vault_key);
    if (!pass) {
      throw new Error(`missing password for vault ${user.password_vault_key}`);
    }
    exportLines.push(`export ${envVar}=${shellQuote(pass)}`);
    userEnvVars.push({ username: user.username, envVar });
  });
  return `${exportLines.join("\n")}\n${renderPasswdScript(userEnvVars)}`;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} mosquitto
 * @param {Map<string, string>} secrets
 * @param {{ skipTlsObtain?: boolean }} [opts]
 */
export async function installMosquittoInCt(user, pveHost, vmid, mosquitto, secrets, opts = {}) {
  errout.write(`[hdc] mosquitto install: apt + config in CT ${vmid} …\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, "mosquitto install");
  if (!ready) {
    return { ok: false, method: "mosquitto", message: `CT ${vmid} not reachable via pct exec` };
  }

  ensureCertbotPackages(user, pveHost, vmid);

  if (tlsEnabled(mosquitto) && !opts.skipTlsObtain) {
    const exec = createMosquittoExec(user, pveHost, vmid);
    try {
      obtainOrRenewCertOnGuest({ exec, mosquitto, forceRenew: false });
    } catch (e) {
      return {
        ok: false,
        method: "mosquitto",
        message: String(/** @type {Error} */ (e).message || e),
      };
    }
  }

  const conf = renderMosquittoConf(mosquitto);
  const acl = renderAclFile(mosquitto);
  const passwdScript = buildPasswdScriptWithSecrets(mosquitto, secrets);
  const script = buildApplyScript(conf, acl, passwdScript, { withPackages: false });
  const r = pctExec(user, pveHost, vmid, script);
  if (r.status !== 0) {
    return { ok: false, method: "mosquitto", message: `install failed (exit ${r.status})` };
  }

  return {
    ok: true,
    method: "mosquitto",
    message: "installed and active",
    tls_port: tlsEnabled(mosquitto) ? tlsListenerPort(mosquitto) : null,
    cert_name: tlsEnabled(mosquitto) ? tlsCertName(mosquitto) : null,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} mosquitto
 * @param {Map<string, string>} secrets
 * @param {{ renewCerts?: boolean; skipCertRenew?: boolean }} [opts]
 */
export async function maintainMosquittoInCt(user, pveHost, vmid, mosquitto, secrets, opts = {}) {
  errout.write(`[hdc] mosquitto maintain: re-applying config in CT ${vmid} …\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, "mosquitto maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const exec = createMosquittoExec(user, pveHost, vmid);
  /** @type {Record<string, unknown> | undefined} */
  let tlsResult;
  if (tlsEnabled(mosquitto)) {
    if (opts.renewCerts) {
      try {
        tlsResult = renewCertsOnGuest(exec, mosquitto);
      } catch (e) {
        return { ok: false, message: String(/** @type {Error} */ (e).message || e) };
      }
    } else if (!opts.skipCertRenew) {
      try {
        tlsResult = obtainOrRenewCertOnGuest({ exec, mosquitto, forceRenew: false });
      } catch (e) {
        return { ok: false, message: String(/** @type {Error} */ (e).message || e) };
      }
    }
  }

  const conf = renderMosquittoConf(mosquitto);
  const acl = renderAclFile(mosquitto);
  const passwdScript = buildPasswdScriptWithSecrets(mosquitto, secrets);
  const script = buildApplyScript(conf, acl, passwdScript);
  const r = pctExec(user, pveHost, vmid, script);
  if (r.status !== 0) {
    return { ok: false, message: `maintain failed (exit ${r.status})`, tls: tlsResult };
  }
  return { ok: true, message: "config applied", tls: tlsResult };
}
