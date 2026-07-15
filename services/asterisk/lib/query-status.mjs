import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { sipPort, twilioEnabled } from "./asterisk-render.mjs";

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 */
function queryViaExec(exec) {
  const svc = exec.run("systemctl is-active asterisk 2>/dev/null || echo inactive", {
    capture: true,
  });
  const serviceActive = svc.stdout.trim() === "active";

  const endpoints = exec.run("asterisk -rx 'pjsip show endpoints' 2>/dev/null | head -40", {
    capture: true,
  });
  const endpointSummary = endpoints.stdout.trim().slice(0, 800);

  return {
    service_active: serviceActive,
    pjsip_endpoints_preview: endpointSummary || null,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export async function queryAsteriskInCt(user, pveHost, vmid) {
  errout.write(`[hdc] asterisk query: live probe CT ${vmid} …\n`);
  const exec = createConfigureExec("pct", { user, host: pveHost, vmid, pveHost });
  const live = queryViaExec(exec);
  return { ok: live.service_active, vmid, ...live };
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 */
export async function queryAsteriskViaExec(exec) {
  errout.write(`[hdc] asterisk query: live probe ${exec.label} …\n`);
  const live = queryViaExec(exec);
  return { ok: live.service_active, ...live };
}

/**
 * @param {Record<string, unknown>} asterisk
 * @param {string | null} ip
 */
export function buildQuerySummary(asterisk, ip) {
  const port = sipPort(asterisk);
  return {
    sip_port: port,
    twilio_enabled: twilioEnabled(asterisk),
    ip,
    sip_uri: ip ? `sip:${ip}:${port}` : null,
  };
}
