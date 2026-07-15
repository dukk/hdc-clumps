import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import {
  plainListenerPort,
  tlsCertName,
  tlsEnabled,
  tlsListenerPort,
} from "./mosquitto-render.mjs";
import { certExistsOnGuest, createMosquittoExec } from "./mosquitto-tls.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} mosquitto
 */
export async function queryMosquittoInCt(user, pveHost, vmid, mosquitto) {
  const cfg = isObject(mosquitto) ? mosquitto : {};
  const service = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active mosquitto 2>/dev/null || echo inactive",
    { capture: true },
  );
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  /** @type {Record<string, unknown>} */
  const tls = {};
  if (tlsEnabled(cfg)) {
    const certName = tlsCertName(cfg);
    const exec = createMosquittoExec(user, pveHost, vmid);
    tls.cert_name = certName;
    tls.listener_port = tlsListenerPort(cfg);
    tls.cert_present = certExistsOnGuest(exec, certName);
    const expiry = exec.run(
      `openssl x509 -in /etc/letsencrypt/live/${certName.replace(/[^a-zA-Z0-9._-]/g, "")}/fullchain.pem -noout -enddate 2>/dev/null || true`,
      { capture: true },
    );
    tls.cert_not_after =
      expiry.status === 0 && expiry.stdout.trim()
        ? expiry.stdout.trim().replace(/^notAfter=/, "")
        : null;
  }

  const plainPort = plainListenerPort(cfg);
  let mqttProbe = null;
  if (service.stdout.trim() === "active") {
    const port = tlsEnabled(cfg) ? tlsListenerPort(cfg) : plainPort;
    const probe = pctExec(
      user,
      pveHost,
      vmid,
      `timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/${port}' 2>/dev/null && echo open || echo closed`,
      { capture: true },
    );
    mqttProbe = probe.stdout.trim() || null;
  }

  return {
    vmid,
    service_active: service.stdout.trim(),
    ct_ip: ctIp,
    tls_enabled: tlsEnabled(cfg),
    tls,
    plain_listener_port: plainPort,
    listener_probe: mqttProbe,
  };
}
